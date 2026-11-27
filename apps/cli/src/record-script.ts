// Scripted recordings: `graft record mark|wait|run`. A mark names a beat on the clip clock (with the
// bounds of an element, read without any automation glow); wait blocks on a real condition (an
// element, a URL, a loaded page or a finished chat) instead of sleeps or frame diffing; run records
// one real prompt from start to stop in a single command.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Args } from "browserkit/dist/args.js";
import type { AttentionChat } from "./client.js";
import type { DaemonHost } from "./host.js";
import type { GraftClient } from "./client.js";
import { loadState, type RecordState } from "./record-capture.js";
import type { Box, Mark, SoundCue } from "./record-events.js";

const MARKS = "marks.json";
// The tab on camera: the active tab, whatever it shows (a site, a Graft page, about:blank), read in
// place. browser.activeTab() refuses Graft's pages and a tab another session holds; reads need no
// attaching.
export const ACTIVE =
  "const tabs = await browser.tabs(); const tab = tabs.find((t) => t.active) ?? tabs[0]; if (!tab) throw new Error('No tab is open');";
// Page code cannot run in Graft's own pages (Chrome refuses scripting there, so the engine's password
// check fails first): say so plainly instead of the engine's PASSWORD_PAGE text.
const READABLE = `${ACTIVE} if (tab.graftUi) throw new Error("The active tab is a Graft page, which page code cannot read: mark it with --box x,y,w,h, or read a web page");`;
const CUES = new Set(["key", "trigger", "arrive", "shutter"]);
const SESSION = "graft-record";

export type RecordSteps = {
  start(args: Args): Promise<number>;
  stop(args: Args): Promise<number>;
  /** The active recording's folder: --out, else the last `record start`. */
  folder(args: Args): string;
  log(line: string): void;
};

function text(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

/** `x,y,w,h` in clip px. */
export function parseBox(value: string): Box {
  const parts = value.split(",").map((part) => Number(part.trim()));
  const [x = NaN, y = NaN, width = NaN, height = NaN] = parts;
  if (parts.length !== 4 || !parts.every(Number.isFinite) || !(width > 0) || !(height > 0))
    throw new Error(`--box wants x,y,w,h in clip pixels, got "${value}"`);
  return { x, y, width, height };
}

/** What the page reports about its window, in CSS px. */
export type PageFrame = { dpr: number; top: number; side: number };
/** The page's own sizes (CSS px) behind a frame: outer can be 0 under Xvfb with no decorations. */
export type PageSizes = {
  dpr: number;
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
};

/**
 * The browser UI around the viewport. Chrome's own outer size wins when it is real; when it is not
 * (outerHeight 0 under Xvfb/openbox) the captured window size (device px) stands in for it.
 */
export function frameOf(page: PageSizes, geometry?: { w: number; h: number }): PageFrame {
  const dpr = page.dpr > 0 ? page.dpr : 1;
  const outerH = page.outerHeight > page.innerHeight ? page.outerHeight : (geometry?.h ?? 0) / dpr;
  const outerW = page.outerWidth >= page.innerWidth ? page.outerWidth : (geometry?.w ?? 0) / dpr;
  return {
    dpr,
    top: Math.max(0, outerH - page.innerHeight),
    side: Math.max(0, (outerW - page.innerWidth) / 2),
  };
}

/** A box cut to the viewport; null when none of it is visible. */
export function clampBox(box: Box, width: number, height: number): Box | null {
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const right = Math.min(width, box.x + box.width);
  const bottom = Math.min(height, box.y + box.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * A page box (CSS px) in captured-window px: the toolbar above the viewport and the side borders
 * are added, then everything scales by devicePixelRatio (the capture is device pixels).
 */
export function windowBoxOf(box: Box, frame: PageFrame): Box {
  const scale = frame.dpr > 0 ? frame.dpr : 1;
  const round = (value: number) => Math.round(value * scale);
  return {
    x: round(box.x + Math.max(0, frame.side)),
    y: round(box.y + Math.max(0, frame.top)),
    width: round(box.width),
    height: round(box.height),
  };
}

export function readMarks(folder: string): Mark[] {
  const file = join(folder, MARKS);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as Mark[]) : [];
  } catch {
    return [];
  }
}

/** Foley for the marks that asked for a cue, merged into the action cues in time order. */
export function withMarkCues(cues: SoundCue[], marks: Mark[]): SoundCue[] {
  const extra = marks.flatMap((mark) => (mark.cue ? [{ t: mark.t, kind: mark.cue }] : []));
  return [...cues, ...extra].sort((a, b) => a.t - b.t);
}

/** Reads an element's bounds and the page's sizes from the active tab; a read, so no glow. */
export function boundsCode(selector: string | undefined): string {
  return `${READABLE}
return await browser.page(tab.id).inspect((selector) => {
  const node = selector ? document.querySelector(selector) : null;
  const rect = node ? node.getBoundingClientRect() : null;
  return {
    box: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    dpr: devicePixelRatio, innerWidth, innerHeight, outerWidth, outerHeight,
  };
}, ${JSON.stringify(selector ?? "")});`;
}

type Bounds = { box: Box | null } & PageFrame;
type PageBounds = { box: Box | null } & PageSizes;

/** The visible part of the element, with the frame that places it in the captured window. */
export function boundsOf(read: PageBounds, geometry?: { w: number; h: number }): Bounds {
  return {
    box: read.box ? clampBox(read.box, read.innerWidth, read.innerHeight) : null,
    ...frameOf(read, geometry),
  };
}

export function markOf(
  name: string,
  t: number,
  options: { label?: string; cue?: string; box?: Box; bounds?: Bounds },
): Mark {
  if (options.cue && !CUES.has(options.cue))
    throw new Error(`--cue is one of key, trigger, arrive, shutter (got "${options.cue}")`);
  const pageBox = options.bounds?.box ?? undefined;
  return {
    name,
    t: Math.max(0, Math.round(t)),
    ...(options.label ? { label: options.label } : {}),
    ...(pageBox ? { box: pageBox } : {}),
    ...(pageBox && options.bounds
      ? { windowBox: windowBoxOf(pageBox, options.bounds) }
      : options.box
        ? { windowBox: options.box }
        : {}),
    ...(options.cue ? { cue: options.cue as NonNullable<Mark["cue"]> } : {}),
  };
}

function activeState(steps: RecordSteps, args: Args): RecordState {
  const state = loadState(steps.folder(args));
  return state;
}

/** Later calls go to the Chrome profile the recording started on, unless --browser names one. */
function followBrowser(host: DaemonHost, state: RecordState): void {
  if (!host.browser && state.browser) host.pinBrowser(state.browser);
}

export async function mark(host: DaemonHost, steps: RecordSteps, args: Args): Promise<number> {
  const name = args.positional[1];
  const usage =
    'Usage: graft record mark <name> [--label "…"] [--selector "<css>"] [--box x,y,w,h] [--cue key|trigger|arrive|shutter]';
  if (!name) throw new Error(usage);
  const state = activeState(steps, args);
  const t = Date.now() - state.startedAt;
  followBrowser(host, state);
  const selector = text(args, "selector");
  const boxFlag = text(args, "box");
  let bounds: Bounds | undefined;
  if (selector) {
    const read = (await host.runInBrowser(boundsCode(selector), {
      session: SESSION,
      timeoutMs: 8_000,
    })) as PageBounds | null;
    if (!read?.box) throw new Error(`No element matches ${selector} in the active tab`);
    bounds = boundsOf(read, state.geometry);
    if (!bounds.box) throw new Error(`${selector} is outside the visible page`);
  }
  const label = text(args, "label");
  const cue = text(args, "cue");
  const made = markOf(name, t, {
    ...(label ? { label } : {}),
    ...(cue ? { cue } : {}),
    ...(boxFlag ? { box: parseBox(boxFlag) } : {}),
    ...(bounds ? { bounds } : {}),
  });
  const marks = [...readMarks(state.folder), made];
  writeFileSync(join(state.folder, MARKS), JSON.stringify(marks, null, 2));
  steps.log(`Marked ${name} at ${(made.t / 1000).toFixed(2)} s`);
  return 0;
}

/** A chat is finished once it was seen working and stopped, or stopped with its completion. */
export function chatFinished(chat: AttentionChat | undefined, seenWorking: boolean): boolean {
  if (!chat || chat.working) return false;
  return seenWorking || chat.completionId !== null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it answers true or the deadline passes. */
export async function until(
  check: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
  everyMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let last: unknown;
    if (await check().catch((error: unknown) => ((last = error), false))) return;
    if (Date.now() >= deadline)
      throw new Error(
        `Timed out after ${timeoutMs} ms waiting for ${what}` +
          (last instanceof Error ? ` (last error: ${last.message})` : ""),
      );
    await sleep(everyMs);
  }
}

function waitForChat(host: DaemonHost, chatId: string, timeoutMs: number): Promise<void> {
  return host.connect().then(
    (client) =>
      new Promise<void>((resolve, reject) => {
        let seenWorking = false;
        // "latest": the first chat seen working after this wait began (a box-typed prompt).
        let target = chatId === "latest" ? undefined : chatId;
        const timer = setTimeout(() => {
          stop();
          reject(new Error(`Timed out after ${timeoutMs} ms waiting for chat ${chatId}`));
        }, timeoutMs);
        const stop = client.onAttention((chats) => {
          target ??= chats.find((item) => item.working)?.chatId;
          const chat = target ? chats.find((item) => item.chatId === target) : undefined;
          if (chat?.working) seenWorking = true;
          if (!chatFinished(chat, seenWorking)) return;
          clearTimeout(timer);
          stop();
          resolve();
        });
      }),
  );
}

function pageRead(host: DaemonHost, body: string, arg: string): Promise<unknown> {
  return host.runInBrowser(
    `${READABLE}
return await browser.page(tab.id).inspect((arg) => { ${body} }, ${JSON.stringify(arg)});`,
    { session: SESSION, timeoutMs: 8_000 },
  );
}

export async function wait(host: DaemonHost, steps: RecordSteps, args: Args): Promise<number> {
  const kind = text(args, "for");
  const timeoutMs = Number(text(args, "timeout") ?? 60_000);
  const usage =
    "Usage: graft record wait --for selector|url|idle|chat [--selector <css>] [--url <text>] [--chat <id>] [--timeout ms]";
  try {
    followBrowser(host, activeState(steps, args));
  } catch {
    // Waiting works without an active recording too (before start, in a script).
  }
  if (kind === "chat") {
    const chatId = text(args, "chat");
    if (!chatId) throw new Error(usage);
    await waitForChat(host, chatId, timeoutMs);
  } else if (kind === "selector") {
    const selector = text(args, "selector");
    if (!selector) throw new Error(usage);
    await until(
      async () =>
        (await pageRead(host, "return !!document.querySelector(arg);", selector)) === true,
      timeoutMs,
      selector,
    );
  } else if (kind === "url") {
    const part = text(args, "url");
    if (!part) throw new Error(usage);
    await until(
      async () =>
        String(
          (
            (await host.runInBrowser(`${ACTIVE} return tab;`, {
              session: SESSION,
              timeoutMs: 8_000,
            })) as { url?: string } | null
          )?.url ?? "",
        ).includes(part),
      timeoutMs,
      `a URL with ${part}`,
    );
  } else if (kind === "idle") {
    // Loaded and still: two reads in a row agree the document is complete.
    let streak = 0;
    await until(
      async () => {
        const done = (await pageRead(host, "return document.readyState;", "")) === "complete";
        streak = done ? streak + 1 : 0;
        return streak >= 2;
      },
      timeoutMs,
      "the page to settle",
      300,
    );
  } else throw new Error(usage);
  steps.log(`Ready: ${kind}`);
  return 0;
}

/** Flags that belong to `record start`, passed through from `record run`. */
function startArgs(args: Args): Args {
  return {
    ...args,
    positional: [
      "start",
      ...args.positional
        .slice(2)
        .filter((word) => ["chrome", "window", "screen", "tabs"].includes(word)),
    ],
  };
}

export async function run(host: DaemonHost, steps: RecordSteps, args: Args): Promise<number> {
  const prompt = args.positional[1];
  if (!prompt)
    throw new Error(
      'Usage: graft record run "<prompt>" [--url <url>] [--browser name] [--out dir] [--window chrome|--tabs] [--no-mouse] [--tail s] [--background]',
    );
  const started = Date.now();
  await openUrl(host, text(args, "url"));
  await steps.start(startArgs(args));
  let chatId: string | undefined;
  try {
    chatId = await runPrompt(host, steps, args, prompt, (id) => (chatId = id));
  } finally {
    await steps.stop({
      ...args,
      positional: ["stop"],
      flags: { ...args.flags, ...(chatId ? { chat: chatId } : {}) },
    });
  }
  summarizeRun(steps, args, started);
  return 0;
}

export async function openUrl(host: DaemonHost, url: string | undefined): Promise<void> {
  if (!url) return;
  await host.runInBrowser(
    `${ACTIVE} await browser.page(tab.id).goto(${JSON.stringify(url)}); return tab.id;`,
    { session: SESSION, timeoutMs: 30_000 },
  );
}

/** Runs the prompt as a real chat, waits until it has truly finished, then holds --tail. */
export async function runPrompt(
  host: DaemonHost,
  steps: RecordSteps,
  args: Args,
  prompt: string,
  started: (chatId: string) => void,
): Promise<string | undefined> {
  const client = await host.connect();
  const { runTasks } = await import("./run.js");
  const tail = Number(text(args, "tail") ?? 2.5);
  // The camera films the window in front: the agent's tabs must open there, or the take shows
  // nothing. Work in front is on for the take and restored after; --background keeps it as is.
  const restore = args.flags.background === true ? undefined : await workInFront(client);
  try {
    return await promptTake(client, runTasks, host, steps, args, prompt, started, tail);
  } finally {
    if (restore) await client.settings({ agentInFront: false }).catch(() => undefined);
  }
}

/** Turns Work in front on; true when it was off (so the take restores it). */
async function workInFront(client: GraftClient): Promise<boolean> {
  const browsers = await client.settings(undefined).catch(() => [] as unknown[]);
  const off = browsers.some(
    (browser) => (browser as { agentInFront?: unknown } | null)?.agentInFront !== true,
  );
  if (!off) return false;
  await client.settings({ agentInFront: true }).catch(() => undefined);
  return true;
}

async function promptTake(
  client: GraftClient,
  runTasks: typeof import("./run.js").runTasks,
  host: DaemonHost,
  steps: RecordSteps,
  args: Args,
  prompt: string,
  started: (chatId: string) => void,
  tail: number,
): Promise<string | undefined> {
  const [result] = await runTasks(client, [prompt], {
    parallel: 1,
    quiet: false,
    origin: "cli",
    ...(host.browser ? { browser: host.browser } : {}),
    ...(args.flags.typed === true ? { typed: true } : {}),
    timeoutMs: Number(text(args, "timeout") ?? 600_000),
    onStarted: (_index, id) => started(id),
    onProgress: steps.log,
  });
  if (result) steps.log(`Chat ${result.chatId}: ${result.status}`);
  await sleep(Math.max(0, tail) * 1000);
  return result?.chatId;
}

function summarizeRun(steps: RecordSteps, args: Args, started: number): void {
  const folder = steps.folder(args);
  const events = JSON.parse(readFileSync(join(folder, "events.json"), "utf8")) as {
    clip?: { durationMs?: number };
    events?: unknown[];
  };
  steps.log(
    `Recorded in ${((Date.now() - started) / 1000).toFixed(1)} s: ${folder} · ${((events.clip?.durationMs ?? 0) / 1000).toFixed(1)} s clip · ${events.events?.length ?? 0} event(s)`,
  );
}

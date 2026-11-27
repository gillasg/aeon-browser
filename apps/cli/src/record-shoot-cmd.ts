// The real wiring of `graft record shoot` and `graft record ui`: plan steps become the same
// start/stop/mark/wait/run calls a hand-written recording script would make, in one process.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Args } from "browserkit/dist/args.js";
import type { DaemonHost } from "./host.js";
import { assemble, assembleOptionsOf } from "./record-assemble.js";
import { writeEvents } from "./record-events.js";
import { alignInto } from "./record-align.js";
import { beatSeen, readBeats, type FilmAction } from "./record-beats.js";
import { useRecordingBrowser } from "./record-browsers.js";
import { mark, openUrl, runPrompt, wait, type RecordSteps } from "./record-script.js";
import { parsePlan, shoot, SHOOT_USAGE, shootTarget, type ShootDeps } from "./record-shoot.js";
import { attachTerminal, readRecording, runTerminal } from "./record-terminal.js";
import { liveUiDeps, performUi, uiCommand } from "./record-ui.js";

const SESSION = "graft-record";
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function flags(args: Args, extra: Record<string, string | true>): Args {
  return { positional: [], flags: { ...args.flags, ...extra } };
}

function markFlags(step: { label?: string; selector?: string; box?: string; cue?: string }) {
  const out: Record<string, string> = {};
  for (const key of ["label", "selector", "box", "cue"] as const) {
    const value = step[key];
    if (value) out[key] = value;
  }
  return out;
}

export function liveShootDeps(host: DaemonHost, steps: RecordSteps, args: Args): ShootDeps {
  const at = (folder: string) => flags(args, { out: folder });
  const markNamed = (folder: string, name: string, extra: Record<string, string> = {}) =>
    mark(host, steps, {
      positional: ["mark", name],
      flags: { ...at(folder).flags, ...extra },
    }).then(() => undefined);
  const director = directorDeps(host, markNamed);
  return {
    start: async (folder) => {
      mkdirSync(folder, { recursive: true });
      await steps.start({ positional: ["start"], flags: { ...at(folder).flags } });
    },
    stop: async (folder, chatId) => {
      await steps.stop({
        positional: ["stop"],
        flags: { ...at(folder).flags, ...(chatId ? { chat: chatId } : {}) },
      });
    },
    open: (url) => openUrl(host, url),
    ui: async (action, folder, name) => {
      await performUi(action, liveUiDeps(host));
      if (name) await markNamed(folder, name);
    },
    run: (folder, step) => {
      const extra: Record<string, string | true> = {};
      if (step.tail !== undefined) extra.tail = String(step.tail);
      if (step.timeout !== undefined) extra.timeout = String(step.timeout);
      if (step.background) extra.background = true;
      return runPrompt(
        host,
        steps,
        { positional: [], flags: { ...at(folder).flags, ...extra } },
        step.run,
        () => undefined,
      );
    },
    mark: (folder, step) => markNamed(folder, step.mark, markFlags(step)),
    wait: async (folder, step) => {
      if (step.wait === "beat")
        return director.waitBeat(step.beat ?? "receipt", step.timeout ?? 60_000);
      const extra: Record<string, string> = { for: step.wait };
      for (const key of ["selector", "url", "chat"] as const) {
        const value = step[key];
        if (value) extra[key] = value;
      }
      if (step.timeout !== undefined) extra.timeout = String(step.timeout);
      await wait(host, steps, { positional: ["wait"], flags: { ...at(folder).flags, ...extra } });
    },
    hold: sleep,
    reload: async () => {
      await performUi("reload", liveUiDeps(host));
    },
    terminal: async (folder, command) => {
      const { cast } = await runTerminal(command);
      await writeEvents(folder, attachTerminal(readRecording(folder), cast));
    },
    code: async (js, timeoutMs) => {
      await host.runInBrowser(js, { session: SESSION, timeoutMs: timeoutMs ?? 60_000 });
    },
    type: director.type,
    press: director.press,
    reset: director.reset,
    align: director.align,
    join,
    log: steps.log,
  };
}

const filmBus = (host: DaemonHost) => (action: FilmAction) => host.film(action);

/** Steps a person would do, done by the director with real X key events and disclosed as such. */
function directorDeps(
  host: DaemonHost,
  markNamed: (folder: string, name: string, extra?: Record<string, string>) => Promise<void>,
): Pick<ShootDeps, "type" | "press" | "reset" | "align"> & {
  waitBeat(beat: string, timeoutMs: number): Promise<void>;
} {
  const xdo = (args: string[]) => execFileSync("xdotool", args, { stdio: "ignore" });
  return {
    type: async (folder, step) => {
      await markNamed(folder, "director:type", { label: step.type, cue: "key" });
      xdo(["type", "--delay", String(step.delay ?? 70), "--", step.type]);
    },
    press: async (folder, step) => {
      await markNamed(folder, "director:press", { label: step.press, cue: "trigger" });
      xdo(["key", "--clearmodifiers", step.press]);
    },
    reset: async (step) => {
      const { forgetAbility, listAbilities } = await import("@browserkit/site-mapper");
      for (const ability of await listAbilities(step.reset).catch(() => []))
        await forgetAbility(step.reset, ability.name).catch(() => false);
      if (step.boost)
        await host.runInBrowser(
          `const site = ${JSON.stringify(step.reset)}; const all = await browser.boosts.list("https://" + site + "/"); for (const b of all ?? []) await browser.boosts.remove(b.id); return true;`,
          { session: SESSION, timeoutMs: 15_000 },
        );
    },
    align: async (folder, step) => {
      const aligned = alignInto(readRecording(folder), step.align, step.line);
      if (aligned) await writeEvents(folder, aligned);
    },
    waitBeat: async (beat, timeoutMs) => {
      const since = Date.now();
      while (Date.now() - since < timeoutMs) {
        if (beatSeen(await readBeats(filmBus(host)), beat, since)) return;
        await sleep(250);
      }
      throw new Error(`Timed out after ${timeoutMs} ms waiting for the ${beat} beat`);
    },
  };
}

/** `graft record shoot <plan.json>`. */
export async function shootCommand(
  host: DaemonHost,
  steps: RecordSteps,
  args: Args,
): Promise<number> {
  const file = args.positional[1];
  if (!file) throw new Error(SHOOT_USAGE);
  const plan = parsePlan(JSON.parse(readFileSync(file, "utf8")));
  if (!host.browser && plan.browser) host.pinBrowser(plan.browser);
  useRecordingBrowser(args, host.browser);
  const { dir, mp4 } = shootTarget(
    typeof args.flags.out === "string" ? args.flags.out : plan.out,
    args.flags.assemble === true,
    resolve,
  );
  const fps = typeof args.flags.fps === "string" ? args.flags.fps : String(plan.fps ?? 30);
  const started = Date.now();
  const takeArgs: Args = { positional: [], flags: { ...args.flags, fps } };
  delete takeArgs.flags.out;
  const folders = await shoot(plan, dir, liveShootDeps(host, steps, takeArgs));
  steps.log(
    `Shot ${folders.length} scene(s) in ${((Date.now() - started) / 1000).toFixed(1)} s: ${dir}`,
  );
  if (mp4) {
    const out = mp4;
    await assemble({
      ...assembleOptionsOf({ ...args, flags: { ...args.flags, fps } }),
      dirs: folders,
      out,
      log: steps.log,
    });
  }
  return 0;
}

/** `graft record ui <action>`; --mark records a mark in the active recording at the beat. */
export function recordUi(host: DaemonHost, steps: RecordSteps, args: Args): Promise<number> {
  const name = typeof args.flags.mark === "string" ? args.flags.mark : undefined;
  return uiCommand(
    args,
    liveUiDeps(host),
    async () => {
      if (name) await mark(host, steps, { ...args, positional: ["mark", name] });
    },
    steps.log,
  );
}

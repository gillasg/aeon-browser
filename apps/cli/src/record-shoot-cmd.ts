// The real wiring of `aeon record shoot` and `aeon record ui`: plan steps become the same
// start/stop/mark/wait/run calls a hand-written recording script would make, in one process.
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Args } from "browserkit/dist/args.js";
import type { DaemonHost } from "./host.js";
import { assemble, assembleOptionsOf } from "./record-assemble.js";
import { writeEvents } from "./record-events.js";
import { useRecordingBrowser } from "./record-browsers.js";
import { mark, openUrl, runPrompt, wait, type RecordSteps } from "./record-script.js";
import { parsePlan, shoot, SHOOT_USAGE, shootTarget, type ShootDeps } from "./record-shoot.js";
import { attachTerminal, readRecording, runTerminal } from "./record-terminal.js";
import { liveUiDeps, performUi, uiCommand } from "./record-ui.js";

const SESSION = "aeon-record";
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
    join,
    log: steps.log,
  };
}

/** `aeon record shoot <plan.json>`. */
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

/** `aeon record ui <action>`; --mark records a mark in the active recording at the beat. */
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

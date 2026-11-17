// `aeon record start|stop`, plus the browserkit `record gif|video|trace` the command overrides.
// start leaves a real-window/screen capture running (or switches on Aeon's hidden tab takes); stop
// writes the final events.json in the folder. The folder is self-contained: frames, clip.mp4 and a
// log an editor can trust.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Args } from "browserkit/dist/args.js";
import type { Command } from "browserkit/dist/usage.js";
import { dataDirectory } from "./client.js";
import type { DaemonHost } from "./host.js";
import {
  defaultFolder,
  ffprobeBinary,
  frameSize,
  loadState,
  startCapture,
  stopCapture,
  type RecordOptions,
  type Source,
} from "./record-capture.js";
import { eventsFromTrace, writeEvents, type RecordingEvents, type Trace } from "./record-events.js";

const log = (line: string) => process.stdout.write(line + "\n");

/** The last `record start`, so `record stop` finds it without repeating --out. */
function pointer(out?: string): string {
  return join(dataDirectory(), "recordings", out ? "current-explicit" : "current");
}
function remember(folder: string, out?: string): void {
  const file = pointer(out);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, folder);
}
function remembered(out?: string): string {
  return readFileSync(pointer(out), "utf8").trim();
}

function sourceOf(args: Args): Source {
  if (args.positional.includes("tabs") || args.flags?.tabs === true) return "tabs";
  if (args.positional.includes("screen") || args.flags?.screen === true) return "screen";
  if (
    args.positional.includes("chrome") ||
    args.positional.includes("window") ||
    args.flags?.window !== undefined
  )
    return "window";
  return "window";
}

function optionsOf(args: Args): RecordOptions {
  const out = typeof args.flags?.out === "string" ? args.flags.out : undefined;
  const ffmpeg = typeof args.flags?.ffmpeg === "string" ? args.flags.ffmpeg : undefined;
  const ffprobe = typeof args.flags?.ffprobe === "string" ? args.flags.ffprobe : undefined;
  return {
    source: sourceOf(args),
    fps: Number(args.flags?.fps ?? 30),
    ...(out ? { out } : {}),
    ...(ffmpeg ? { ffmpeg } : {}),
    ...(ffprobe ? { ffprobe } : {}),
    log,
  };
}

async function start(args: Args): Promise<number> {
  const opts = optionsOf(args);
  const folder = defaultFolder(opts.out);
  mkdirSync(folder, { recursive: true });
  remember(folder, opts.out);
  const state = await startCapture(folder, opts);
  const chatId = typeof args.flags?.chat === "string" ? args.flags.chat : undefined;
  if (chatId) {
    state.chatId = chatId;
    // Persist the chat id too: start writes the state before we add it here.
    const { saveState } = await import("./record-capture.js");
    saveState(folder, state);
  }
  // A log exists from the first moment: the folder is never missing events.json, even if stop is
  // never called (the metadata says the recording is still open).
  const size = frameSize(folder, ffprobeBinary(opts));
  const clip = {
    file: state.source === "tabs" ? "takes/" : "clip.mp4",
    source: state.source,
    ...size,
    fps: state.fps,
    startedAt: state.startedAt,
    durationMs: 0,
    frames: 0,
  };
  await writeEvents(folder, {
    version: 1,
    recorder: "aeon",
    clock: "clip",
    clip,
    events: [],
    note: "Recording in progress; run `aeon record stop` to finish the log.",
  });
  log(`Recording ${state.source} into ${folder}`);
  if (state.source === "tabs") log("Aeon's hidden tab takes are on; they are collected at stop.");
  else log("Keep the window unminimized. Run `aeon record stop` when done.");
  return 0;
}

/** Pull the chat's trace through the daemon, best effort; a recording must never hang on it. */
async function traceOf(host: DaemonHost, chatId: string): Promise<Trace | undefined> {
  try {
    const { inspect } = await import("./run.js");
    const result = await inspect(await host.connect(), chatId);
    return result as unknown as Trace;
  } catch {
    return undefined;
  }
}

async function stop(host: DaemonHost, args: Args): Promise<number> {
  const out = typeof args.flags?.out === "string" ? args.flags.out : undefined;
  const folder = out ? defaultFolder(out) : remembered();
  const before = loadState(folder);
  const opts: RecordOptions = { source: before.source, ffmpeg: before.ffmpeg, log };
  const state = await stopCapture(folder, opts);
  // The chat usually starts after the recording, so stop can name it too.
  if (typeof args.flags?.chat === "string") state.chatId = args.flags.chat;
  const size = frameSize(folder, ffprobeBinary(opts));
  const durationMs = state.frames > 1 ? Math.round(((state.frames - 1) / state.fps) * 1000) : 0;
  const clip = {
    file: state.source === "tabs" ? "takes/" : "clip.mp4",
    source: state.source,
    ...size,
    fps: state.fps,
    startedAt: state.startedAt,
    durationMs,
    frames: state.frames,
  };
  const trace = state.chatId ? await traceOf(host, state.chatId) : undefined;
  const events = trace ? eventsFromTrace(trace, state.startedAt) : [];
  const result: RecordingEvents = {
    version: 1,
    recorder: "aeon",
    clock: "clip",
    clip,
    events,
    ...(trace
      ? {}
      : {
          note: "No chat trace was attached at start (use --chat <id> to log Aeon's actions); the clip metadata and frames are still recorded.",
        }),
  };
  await writeEvents(folder, result);
  log(`Stopped. ${state.frames} frames, ${events.length} action(s). Folder: ${folder}`);
  return 0;
}

/** `aeon record`: start/stop are ours; gif/video/trace stay the browserkit command's. */
export function recordCommand(original: Command | undefined, host: DaemonHost): Command {
  return {
    name: "record",
    group: original?.group ?? "Browser",
    summary: "record the real Chrome window or screen into an editable folder",
    help: `Usage: aeon record start [--window chrome|--screen|--tabs] [--out <dir>] [--fps 30] [--chat <id>]
       aeon record stop [--out <dir>] [--chat <id>]
       aeon record gif|video|trace …   (the original screen recordings)

start captures the real window (x11grab on Linux, avfoundation on macOS, gdigrab on
Windows) into a folder with frames, clip.mp4 and events.json. --tabs uses Aeon's own
hidden tab takes instead of a screen. stop finalises the clip and writes the event log.
The folder is a recording, not a video: render it with Remotion (see \`aeon video kit\`).`,
    run: async (args: Args) => {
      const action = args.positional[0];
      if (action === "start") return start(args);
      if (action === "stop") return stop(host, args);
      if (original) return original.run({ ...args, positional: args.positional.slice(1) });
      throw new Error("Usage: aeon record start|stop|gif|video|trace");
    },
  };
}

/** `aeon video kit <dir>` copies the Remotion starter kit (templates are not built into Aeon). */
export async function videoCommand(args: Args): Promise<number> {
  const action = args.positional[0];
  if (action !== "kit") throw new Error("Usage: aeon video kit <dir>");
  const dir = args.positional[1];
  if (!dir) throw new Error("Usage: aeon video kit <dir>");
  const { copyKit } = await import("./video-kit.js");
  const target = await copyKit(dir);
  log(
    `Starter kit copied to ${target}. Install it there with \`npm install\`, then read README.md.`,
  );
  return 0;
}

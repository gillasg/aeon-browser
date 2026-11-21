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
  saveState,
  startCapture,
  stopCapture,
  type RecordOptions,
  type RecordState,
  type Source,
} from "./record-capture.js";
import {
  eventsFromTrace,
  tabClips,
  writeEvents,
  type ClipMeta,
  type RecordingEvents,
  type TerminalCast,
  type Trace,
  type VideoEvent,
} from "./record-events.js";
import { attachTerminal, keptTerminal, readRecording, runTerminal } from "./record-terminal.js";

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

async function start(host: DaemonHost, args: Args): Promise<number> {
  const opts = optionsOf(args);
  const folder = defaultFolder(opts.out);
  mkdirSync(folder, { recursive: true });
  remember(folder, opts.out);
  const state = await startCapture(folder, opts);
  if (opts.source === "tabs") await armTabTakes(host, state);
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
  const terminal = keptTerminal(folder);
  await writeEvents(folder, {
    version: 1,
    recorder: "aeon",
    clock: "clip",
    clip,
    events: [],
    ...(terminal ? { terminal } : {}),
    note: "Recording in progress; run `aeon record stop` to finish the log.",
  });
  log(`Recording ${state.source} into ${folder}`);
  if (state.source === "tabs") log("Aeon's hidden tab takes are on; they are collected at stop.");
  else log("Keep the window unminimized. Run `aeon record stop` when done.");
  return 0;
}

/** Turn on per-tab takes for this recording. A missing daemon still leaves a folder stop can finish. */
async function armTabTakes(host: DaemonHost, state: RecordState): Promise<void> {
  try {
    const client = await host.connect();
    const browsers = await client.settings(undefined, 3_000);
    const was = browsers.some((browser) => browser.recordAgentTabs === true);
    state.recordAgentTabsWas = was;
    if (!was) await client.settings({ recordAgentTabs: true }, 3_000);
    saveState(state.folder, state);
  } catch {
    // No Chrome: stop still writes a clip for every tab the trace opened.
  }
}

/** Tab ids the engine recorded for this chat, when the daemon is up. */
async function recordedTabIds(host: DaemonHost, chatId: string | undefined): Promise<number[]> {
  if (!chatId) return [];
  try {
    const listed = (await host.runInBrowser(
      `return await browser.takes(${JSON.stringify(chatId)})`,
      {
        session: "aeon-record",
        timeoutMs: 8_000,
      },
    )) as { tabId?: unknown }[] | undefined;
    if (!Array.isArray(listed)) return [];
    return listed.flatMap((take) => (typeof take?.tabId === "number" ? [take.tabId] : []));
  } catch {
    return [];
  }
}

/** Pull the chat's trace through the daemon, best effort; a recording must never hang on it. */
async function traceOf(host: DaemonHost, chatId: string | undefined): Promise<Trace | undefined> {
  if (!chatId) return undefined;
  try {
    const { inspect } = await import("./run.js");
    const result = await inspect(await host.connect(), chatId);
    return result as unknown as Trace;
  } catch {
    return undefined;
  }
}

function flagString(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

function stopFolder(args: Args): string {
  const out = flagString(args, "out");
  return out ? defaultFolder(out) : remembered();
}

/** The chat usually starts after the recording, so stop can name it too. */
function nameStopChat(state: RecordState, args: Args): void {
  const chat = flagString(args, "chat");
  if (chat) state.chatId = chat;
}

function clipDuration(frames: number, fps: number): number {
  if (frames <= 1) return 0;
  return Math.round(((frames - 1) / fps) * 1000);
}

function baseClip(
  state: RecordState,
  size: { width: number; height: number },
  durationMs: number,
): ClipMeta {
  return {
    file: state.source === "tabs" ? "takes/" : "clip.mp4",
    source: state.source,
    ...size,
    fps: state.fps,
    startedAt: state.startedAt,
    durationMs,
    frames: state.frames,
  };
}

async function clipsForStop(
  host: DaemonHost,
  state: RecordState,
  events: VideoEvent[],
  clip: ClipMeta,
): Promise<ClipMeta[]> {
  if (state.source !== "tabs") return [];
  return tabClips(events, clip, await recordedTabIds(host, state.chatId));
}

/** Put recordAgentTabs back when this recording was the one that turned it on. */
async function releaseTabTakes(host: DaemonHost, state: RecordState): Promise<void> {
  if (state.source !== "tabs" || state.recordAgentTabsWas !== false) return;
  try {
    const client = await host.connect();
    await client.settings({ recordAgentTabs: false }, 3_000);
  } catch {
    // The setting stays on if Chrome is gone; the user can turn it off.
  }
}

const MISSING_TRACE =
  "No chat trace was attached at start (use --chat <id> to log Aeon's actions); the clip metadata and frames are still recorded.";

function stopRecording(
  clip: ClipMeta,
  clips: ClipMeta[],
  events: VideoEvent[],
  terminal: TerminalCast | undefined,
  traced: boolean,
): RecordingEvents {
  return {
    version: 1,
    recorder: "aeon",
    clock: "clip",
    clip: clips[0] ?? clip,
    ...(clips.length > 0 ? { clips } : {}),
    events,
    ...(terminal ? { terminal } : {}),
    ...(traced ? {} : { note: MISSING_TRACE }),
  };
}

async function stop(host: DaemonHost, args: Args): Promise<number> {
  const folder = stopFolder(args);
  const before = loadState(folder);
  const opts: RecordOptions = { source: before.source, ffmpeg: before.ffmpeg, log };
  const state = await stopCapture(folder, opts);
  nameStopChat(state, args);
  const size = frameSize(folder, ffprobeBinary(opts));
  const clip = baseClip(state, size, clipDuration(state.frames, state.fps));
  const trace = await traceOf(host, state.chatId);
  const events = trace ? eventsFromTrace(trace, state.startedAt) : [];
  const clips = await clipsForStop(host, state, events, clip);
  await releaseTabTakes(host, state);
  await writeEvents(
    folder,
    stopRecording(clip, clips, events, keptTerminal(folder), trace !== undefined),
  );
  log(`Stopped. ${state.frames} frames, ${events.length} action(s). Folder: ${folder}`);
  return 0;
}

/** Record one shell command into the folder's events.json. Run it after start and before stop. */
async function terminal(_host: DaemonHost, args: Args): Promise<number> {
  const command = typeof args.flags?.run === "string" ? args.flags.run : "";
  if (!command) throw new Error('Usage: aeon record terminal --out <dir> --run "<command>"');
  const out = typeof args.flags?.out === "string" ? args.flags.out : undefined;
  let folder: string;
  try {
    folder = out ? defaultFolder(out) : remembered();
  } catch {
    throw new Error('Usage: aeon record terminal --out <dir> --run "<command>"');
  }
  mkdirSync(folder, { recursive: true });
  const { code, cast } = await runTerminal(command);
  await writeEvents(folder, attachTerminal(readRecording(folder), cast));
  log(`Recorded the terminal into ${folder} (${cast.events.length} event(s), exit ${code}).`);
  return code;
}

/** `aeon record`: start/stop are ours; gif/video/trace stay the browserkit command's. */
export function recordCommand(original: Command | undefined, host: DaemonHost): Command {
  return {
    name: "record",
    group: original?.group ?? "Browser",
    summary: "record the real Chrome window or screen into an editable folder",
    help: `Usage: aeon record start [--window chrome|--screen|--tabs] [--out <dir>] [--fps 30] [--chat <id>]
       aeon record stop [--out <dir>] [--chat <id>]
       aeon record terminal --out <dir> --run "<command>"
       aeon record gif|video|trace …   (the original screen recordings)

start captures the real window (x11grab on Linux, avfoundation on macOS, gdigrab on
Windows) into a folder with frames, clip.mp4 and events.json. --tabs records every tab
the chat drives, including one opened mid-run, and stop writes one clip per tab.
terminal records a command and its output into that folder's events.json; the video
kit draws it beside the tab. Run it after start and before stop.
The folder is a recording, not a video: render it with Remotion (see \`aeon video kit\`).`,
    run: async (args: Args) => {
      const action = args.positional[0];
      if (action === "start") return start(host, args);
      if (action === "stop") return stop(host, args);
      if (action === "terminal") return terminal(host, args);
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

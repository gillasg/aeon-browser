// `graft record start|stop`, plus the browserkit `record gif|video|trace` the command overrides.
// start leaves a real-window/screen capture running (or switches on Graft's hidden tab takes); stop
// writes the final events.json in the folder. The folder is self-contained: frames, clip.mp4 and a
// log an editor can trust.
import { mkdirSync } from "node:fs";
import type { Args } from "browserkit/dist/args.js";
import type { Command } from "browserkit/dist/usage.js";
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
  clipScale,
  eventsFromTrace,
  soundCuesFromEvents,
  tabClips,
  writeEvents,
  type ClipMeta,
  type Mark,
  type RecordingEvents,
  type TerminalCast,
  type Trace,
  type VideoEvent,
} from "./record-events.js";
import { useRecordingBrowser } from "./record-browsers.js";
import {
  refuseIfRecording,
  releasePointer,
  requireDaemon,
  stopTarget,
  writePointer,
} from "./record-state.js";
import { mark, readMarks, run, wait, withMarkCues, type RecordSteps } from "./record-script.js";
import { saveTabTakes, type SavedTake } from "./record-takes.js";
import { attachTerminal, keptTerminal, readRecording, runTerminal } from "./record-terminal.js";
import { stutterVerdict } from "./record-truth.js";
import { armBeats, readBeats, withBeats, type FilmAction } from "./record-beats.js";

export const log = (line: string): boolean => process.stdout.write(line + "\n");

/** A fake ffmpeg (GRAFT_FFMPEG or --ffmpeg) is a test take: it needs no daemon. */
function testTake(opts: RecordOptions): boolean {
  return !!(opts.ffmpeg ?? process.env.GRAFT_FFMPEG);
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

function mouseOption(args: Args): { noMouse?: true } {
  return args.flags["no-mouse"] === true ? { noMouse: true } : {};
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
    ...mouseOption(args),
    log,
  };
}

async function start(host: DaemonHost, args: Args): Promise<number> {
  const opts = optionsOf(args);
  refuseIfRecording();
  if (!testTake(opts)) await requireDaemon(() => host.connect());
  const folder = defaultFolder(opts.out);
  mkdirSync(folder, { recursive: true });
  writePointer({ folder, ...(opts.out ? { out: opts.out } : {}) });
  const state = await startCapture(folder, opts);
  if (host.browser) {
    state.browser = host.browser;
    saveState(folder, state);
  }
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
    recorder: "graft",
    clock: "clip",
    clip,
    events: [],
    ...(terminal ? { terminal } : {}),
    note: "Recording in progress; run `graft record stop` to finish the log.",
  });
  await armBeats((action) => host.film(action), true);
  log(`Recording ${state.source} into ${folder}`);
  if (state.source === "tabs") log("Graft's hidden tab takes are on; they are collected at stop.");
  else log("Keep the window unminimized. Run `graft record stop` when done.");
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

/**
 * Tab ids the engine recorded during this recording. With --chat, the chat's takes; without one,
 * every take that started after the recording did (a --tabs run without --chat used to list none,
 * so stop never collected a take).
 */
export async function recordedTabIds(
  run: (code: string) => Promise<unknown>,
  chatId: string | undefined,
  startedAt: number,
): Promise<number[]> {
  try {
    const listed = (await run(
      `return await browser.takes(${chatId ? JSON.stringify(chatId) : ""})`,
    )) as { tabId?: unknown; startedAt?: unknown }[] | undefined;
    if (!Array.isArray(listed)) return [];
    return listed.flatMap((take) =>
      typeof take?.tabId !== "number" ||
      (!chatId && typeof take.startedAt === "number" && take.startedAt < startedAt)
        ? []
        : [take.tabId],
    );
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
  return stopTarget(out ? defaultFolder(out) : undefined);
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
    ...clipScale(size, Number(process.env.GRAFT_RECORDING_DPR) || undefined),
    ...(state.dropped === undefined ? {} : { dropped: state.dropped }),
    ...(state.dup === undefined ? {} : { dup: state.dup }),
  };
}

async function clipsForStop(
  host: DaemonHost,
  state: RecordState,
  events: VideoEvent[],
  clip: ClipMeta,
): Promise<ClipMeta[]> {
  if (state.source !== "tabs") return [];
  const recorded = await recordedTabIds(
    (code) => host.runInBrowser(code, { session: "graft-record", timeoutMs: 8_000 }),
    state.chatId,
    state.startedAt,
  );
  const tabIds = [
    ...new Set([
      ...events.flatMap((event) => (event.tabId === undefined ? [] : [event.tabId])),
      ...recorded,
    ]),
  ];
  const takes = await saveTabTakes(
    (code) => host.runInBrowser(code, { session: "graft-record", timeoutMs: 60_000 }),
    state.folder,
    tabIds,
  ).catch(() => new Map<number, SavedTake>());
  if (tabIds.length && !takes.size)
    log(
      "No tab takes could be copied (is Chrome open with Graft?); clips keep the recording's clock.",
    );
  return tabClips(events, clip, recorded, takes);
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

/** Why events[] is empty, or undefined when the chat's trace was attached. */
export function traceNote(chatId: string | undefined, traced: boolean): string | undefined {
  if (traced) return undefined;
  if (chatId)
    return `The trace of chat ${chatId} could not be read (is it a chat id from \`graft run\` or \`graft chats\`?); the clip metadata and frames are still recorded.`;
  return "No chat was named (use --chat <id> at start or stop to log Graft's actions); the clip metadata and frames are still recorded.";
}

export function stopRecording(
  clip: ClipMeta,
  clips: ClipMeta[],
  events: VideoEvent[],
  terminal: TerminalCast | undefined,
  note: string | undefined,
  marks: Mark[] = [],
): RecordingEvents {
  const cues = withMarkCues(events.length ? soundCuesFromEvents(events) : [], marks);
  return {
    version: 1,
    recorder: "graft",
    clock: "clip",
    clip: clips[0] ?? clip,
    ...(clips.length > 0 ? { clips } : {}),
    events,
    ...(terminal ? { terminal } : {}),
    ...(marks.length ? { marks } : {}),
    ...(cues.length ? { soundCues: cues } : {}),
    ...(note ? { note } : {}),
  };
}

async function stop(host: DaemonHost, args: Args): Promise<number> {
  const folder = stopFolder(args);
  const before = loadState(folder);
  if (!host.browser && before.browser) host.pinBrowser(before.browser);
  useRecordingBrowser(args, host.browser);
  const opts: RecordOptions = {
    source: before.source,
    ffmpeg: before.ffmpeg,
    log,
    ...(args.flags?.["defer-clip"] ? { deferClip: true } : {}),
  };
  const state = await stopCapture(folder, opts);
  releasePointer(folder);
  nameStopChat(state, args);
  const size = frameSize(folder, ffprobeBinary(opts));
  const clip = baseClip(state, size, clipDuration(state.frames, state.fps));
  const trace = await traceOf(host, state.chatId);
  const bus = (action: FilmAction) => host.film(action);
  const beats = await readBeats(bus);
  await armBeats(bus, false);
  const events = withBeats(
    trace ? eventsFromTrace(trace, state.startedAt) : [],
    beats,
    state.startedAt,
  );
  const clips = await clipsForStop(host, state, events, clip);
  await releaseTabTakes(host, state);
  const kept = readRecording(folder)?.align;
  await writeEvents(folder, {
    ...stopRecording(
      clip,
      clips,
      events,
      keptTerminal(folder),
      traceNote(state.chatId, trace !== undefined),
      readMarks(folder),
    ),
    ...(kept ? { align: kept } : {}),
  });
  log(`Stopped. ${state.frames} frames, ${events.length} action(s). Folder: ${folder}`);
  if (state.encodePid) log("clip.mp4 is encoding in the background (--defer-clip).");
  const verdict = stutterVerdict(clip, args.flags?.["allow-stutter"] === true);
  if (verdict.message) log(verdict.message);
  return verdict.code;
}

/** Record one shell command into the folder's events.json. Run it after start and before stop. */
async function terminal(_host: DaemonHost, args: Args): Promise<number> {
  const command = typeof args.flags?.run === "string" ? args.flags.run : "";
  if (!command) throw new Error('Usage: graft record terminal --out <dir> --run "<command>"');
  const out = typeof args.flags?.out === "string" ? args.flags.out : undefined;
  let folder: string;
  try {
    folder = out ? defaultFolder(out) : stopTarget(undefined);
  } catch {
    throw new Error('Usage: graft record terminal --out <dir> --run "<command>"');
  }
  mkdirSync(folder, { recursive: true });
  const { code, cast } = await runTerminal(command);
  await writeEvents(folder, attachTerminal(readRecording(folder), cast));
  log(`Recorded the terminal into ${folder} (${cast.events.length} event(s), exit ${code}).`);
  return code;
}

/** `graft record`: start/stop are ours; gif/video/trace stay the browserkit command's. */
/** start/stop/folder/log wired to this host: what shoot, qualify and film drive. */
export function recordSteps(host: DaemonHost): RecordSteps {
  return {
    start: (args) => start(host, args),
    stop: (args) => stop(host, args),
    folder: stopFolder,
    log,
  };
}

export function recordCommand(original: Command | undefined, host: DaemonHost): Command {
  const steps = recordSteps(host);
  return {
    name: "record",
    group: original?.group ?? "Browser",
    summary: "record the real Chrome window or screen into an editable folder",
    help: `Usage: graft record start [--window chrome|--screen|--tabs] [--out <dir>] [--fps 30] [--chat <id>] [--no-mouse] [--browser <name>] [--display :N]
       graft record stop [--out <dir>] [--chat <id>] [--defer-clip] [--allow-stutter]
       graft record qualify <clip.json> [--runs 3]
       graft record mark <name> [--label "…"] [--selector "<css>"] [--box x,y,w,h] [--cue key|trigger|arrive|shutter] [--out <dir>]
       graft record wait --for selector|url|idle|chat [--selector "<css>"] [--url "<text>"] [--chat <id>] [--timeout <ms>]
       graft record run "<prompt>" [--url <url>] [--out <dir>] [--window chrome|--tabs] [--no-mouse] [--tail 2.5] [--browser <name>] [--display :N] [--background]
       graft record terminal --out <dir> --run "<command>"
       graft record ui cursor|sidepanel|home|chat|manage|chats|automations|sites|settings|models|learn|reload [--mark <name>] [--out <dir>] [--display :N]
       graft record shoot <plan.json> [--out <dir-or-mp4>] [--assemble] [--no-mouse] [--fps 30] [--zoom] [--sound] [--max-idle <ms>] [--browser <name>] [--display :N]
       graft record assemble <dir...> [--out <file.mp4>] [--width 1920] [--height 1080] [--fps 30] [--max-idle <ms>] [--zoom] [--sound] [--end-cmd "<cmd>"] [--end-repo "<url>"] [--ffmpeg <bin>]
       graft record gif|video|trace …   (the original screen recordings)

start captures the real window (x11grab on Linux, avfoundation on macOS, gdigrab on
Windows) into a folder with frames, clip.mp4 and events.json. --tabs records every tab
the chat drives, including one opened mid-run, and stop writes one clip per tab.
terminal records a command and its output into that folder's events.json; the video
kit draws it beside the tab. Run it after start and before stop.
stop refuses (exit 1) a take where ffmpeg dropped or duplicated over 0.5% of frames;
--allow-stutter keeps it with a warning, for quick review clips on a busy machine.
--no-mouse keeps the OS pointer out of the frames (only Graft's cursor is on camera). mark names a
beat on the clip clock; --selector also records the element's box (page CSS px) and windowBox
(clip px), read without any automation glow; stop merges marks (and their --cue sounds) into
events.json. wait blocks on a real condition, never a sleep: an element, a URL, a loaded page, or
a chat that has truly finished. run does it all for one prompt: optionally opens --url, starts,
runs the prompt, waits for the chat to finish, holds --tail seconds, stops, attaches the trace.
run turns Work in front on for the take (restored after) so the agent's tabs are on camera;
--background leaves the setting as it is.
--browser picks one connected Chrome profile; mark, wait and stop follow the one start used. On
Linux a browser set up by setup-recording-chrome.sh brings its own X display and DPR; --display
overrides DISPLAY for capture, xdotool and xwininfo.
ui drives Graft's own surfaces on camera: cursor summons the cursor box (Alt+Shift+Space),
sidepanel opens the side panel from the cursor box, home|chat open the new-chat canvas (home.html?host=panel),
manage opens Manage, chats|automations|sites|settings|models|learn open that Manage page, all in one
reused tab (never a new grouped tab), reload reloads the active tab; --mark marks
the beat. shoot films a whole walkthrough from a plan: {"scenes": [{"name": "…", "steps": [{"open":
"https://…"}, {"ui": "cursor"}, {"run": "…", "tail": 2}, {"mark": "arrive", "selector": "…"},
{"wait": "idle"}, {"hold": 1500}, {"reload": true}, {"terminal": "…"}, {"code": "…"}]}]}. A scene's
"prepare" steps (open, ui, wait, hold, reload, code; no marks) run before the camera rolls. Each
scene is its own take folder; capture always stops, even when a step fails. --assemble (or an
--out ending in .mp4) cuts the takes into one MP4.
assemble is the fast editor (pure ffmpeg, x264 superfast, about real time): takes stitched in
order with hard cuts, --max-idle trims stillness longer than that between beats (holds after
arrivals and receipts stay), --zoom punches in on marked boxes but never past native pixels (a
2560x1440 master allows 1.33x into 1080p), --sound scores keys, triggers and arrival chords, and
--end-cmd/--end-repo add a plain end card. Default to shoot + assemble for walkthroughs; the
Remotion kit (\`graft video kit\`) is for short flagship launch cuts.`,
    run: async (args: Args) => {
      const action = args.positional[0];
      useRecordingBrowser(args, host.browser);
      if (action === "start") return start(host, args);
      if (action === "stop") return stop(host, args);
      if (action === "terminal") return terminal(host, args);
      if (action === "mark") return mark(host, steps, args);
      if (action === "wait") return wait(host, steps, args);
      if (action === "run") return run(host, steps, args);
      if (action === "assemble")
        return (await import("./record-assemble.js")).assembleCommand(args, log);
      if (action === "shoot")
        return (await import("./record-shoot-cmd.js")).shootCommand(host, steps, args);
      if (action === "qualify")
        return (await import("./record-qualify.js")).qualifyCommand(host, steps, args);
      if (action === "ui")
        return (await import("./record-shoot-cmd.js")).recordUi(host, steps, args);
      if (original) return original.run({ ...args, positional: args.positional.slice(1) });
      throw new Error(
        "Usage: graft record start|stop|mark|wait|run|terminal|ui|shoot|qualify|assemble|gif|video|trace",
      );
    },
  };
}

/** `graft video kit <dir>` copies the Remotion starter kit (templates are not built into Graft). */
export async function videoCommand(args: Args): Promise<number> {
  const action = args.positional[0];
  if (action !== "kit") throw new Error("Usage: graft video kit <dir>");
  const dir = args.positional[1];
  if (!dir) throw new Error("Usage: graft video kit <dir>");
  const { copyKit } = await import("./video-kit.js");
  const target = await copyKit(dir);
  log(
    `Starter kit copied to ${target}. Install it there with \`npm install\`, then read README.md.`,
  );
  return 0;
}

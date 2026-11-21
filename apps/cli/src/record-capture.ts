// Real-window / screen capture for `aeon record`. Ported from the Aeon Recorder: ffmpeg x11grab
// on Linux (the real X cursor is in frame), avfoundation on macOS, gdigrab on Windows. Frames are
// written as constant-rate JPEGs so a stop never loses a half-finalised container; a clip.mp4 is
// encoded from them at stop. --tabs uses Aeon's own hidden tab takes instead of the screen.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Source = "window" | "screen" | "tabs";
export type RecordOptions = {
  source: Source;
  fps?: number;
  out?: string;
  /** Test seam: ffmpeg binary (or a fake). */
  ffmpeg?: string;
  ffprobe?: string;
  /** Skip X11 checks (used by tests with a fake ffmpeg). */
  testMode?: boolean;
  log?: (line: string) => void;
};
export type RecordState = {
  version: 1;
  source: Source;
  folder: string;
  fps: number;
  startedAt: number;
  pid?: number;
  ffmpeg: string;
  display?: string;
  geometry?: { x: number; y: number; w: number; h: number };
  frames: number;
  /** Set for --tabs: takes are collected at stop through the daemon. */
  tabSession?: string;
  /** Chat whose trace supplies events.json at stop. */
  chatId?: string;
  /** The ffmpeg input chosen at start (gdigrab `title=…`/`desktop`, avfoundation `N:none`). */
  input?: string;
  /** The recordAgentTabs value before --tabs turned it on, so stop can put it back. */
  recordAgentTabsWas?: boolean;
};

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";
export const isLinux = process.platform === "linux";
const STATE = ".recording.json";
const DEFAULT_FPS = 30;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function ffmpegBinary(opts: Pick<RecordOptions, "ffmpeg">): string {
  return opts.ffmpeg ?? process.env.AEON_FFMPEG ?? "ffmpeg";
}
export function ffprobeBinary(opts: Pick<RecordOptions, "ffprobe">): string {
  return opts.ffprobe ?? process.env.AEON_FFPROBE ?? "ffprobe";
}

/** The X display to grab: DISPLAY when it is live; ":0" only in test mode. */
export function display(testMode = false): string | undefined {
  if (!isLinux) return undefined;
  const d = process.env.DISPLAY;
  if (!d) return testMode ? ":0" : undefined;
  const local = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(d);
  if (!local) return d;
  return testMode || existsSync(`/tmp/.X11-unix/X${local[1]}`) ? d : undefined;
}

function tool(cmd: string, args: string[], testMode = false): string {
  if (testMode) return "";
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const e = error as { code?: string; stderr?: string; message: string };
    if (e.code === "ENOENT")
      throw new Error(`${cmd} is needed to find the Chrome window (install xdotool x11-utils)`, {
        cause: error,
      });
    throw new Error(`${cmd} failed: ${(e.stderr ?? e.message).trim()}`, { cause: error });
  }
}

/** Geometry from xwininfo (root-relative), with xdotool as a fallback. */
export function windowGeometry(
  id: string,
  testMode = false,
): { x: number; y: number; w: number; h: number } {
  const out = tool("xdotool", ["getwindowgeometry", "--shell", id], testMode);
  const g = Object.fromEntries(
    out
      .split("\n")
      .map((line) => line.split("=") as [string, string])
      .filter(([key]) => ["X", "Y", "WIDTH", "HEIGHT"].includes(key ?? "")),
  );
  const w = Number(g.WIDTH ?? 1280);
  const h = Number(g.HEIGHT ?? 720);
  let x = Number(g.X ?? 0);
  let y = Number(g.Y ?? 0);
  try {
    const info = tool("xwininfo", ["-id", id], testMode);
    const abs = (name: string) => Number(new RegExp(`${name}:\\s+(-?\\d+)`).exec(info)?.[1]);
    if (Number.isFinite(abs("Absolute upper-left X"))) x = abs("Absolute upper-left X");
    if (Number.isFinite(abs("Absolute upper-left Y"))) y = abs("Absolute upper-left Y");
  } catch {
    // No reparenting window manager: xdotool's coordinates are already root-relative.
  }
  return { x: x || 0, y: y || 0, w: Math.max(2, w - (w % 2)), h: Math.max(2, h - (h % 2)) };
}

/** Find the frontmost Chrome window by X11 class (or AEON_CHROME_CLASS override). */
export function findChromeWindow(testMode = false): string {
  const klass = process.env.AEON_CHROME_CLASS ?? "[Gg]oogle-[Cc]hrome|[Cc]hromium";
  const ids = tool("xdotool", ["search", "--onlyvisible", "--class", klass], testMode)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (testMode) return ids[0] ?? "test-window";
  let focus = "";
  try {
    focus = tool("xdotool", ["getwindowfocus"], testMode).trim();
  } catch {
    // No window manager on Xvfb: nothing has focus.
  }
  const windows = ids
    .map((id) => ({ id, ...windowGeometry(id, testMode) }))
    .filter((g) => g.w >= 300 && g.h >= 200)
    .sort((a, b) => Number(b.id === focus) - Number(a.id === focus) || b.w * b.h - a.w * a.h);
  const found = windows[0];
  if (!found)
    throw new Error("No visible Chrome window found; open Chrome and keep it unminimized");
  return found.id;
}

export function screenSize(testMode = false): { w: number; h: number } {
  const out = tool("xdotool", ["getdisplaygeometry"], testMode);
  const [w, h] = out.trim().split(/\s+/).map(Number);
  return w && h ? { w: w - (w % 2), h: h - (h % 2) } : { w: 1920, h: 1080 };
}

/**
 * gdigrab's input: `desktop` for the screen, `title=<exact window title>` for a window. Chrome's
 * title is "<page> - Google Chrome", so it is looked up at start (AEON_CHROME_TITLE overrides);
 * without a match the whole desktop is recorded and the caller says so.
 */
export function gdigrabInput(source: Source, chromeTitle: string | undefined): string {
  if (source === "screen") return "desktop";
  const title = chromeTitle?.trim();
  return title ? `title=${title}` : "desktop";
}

/** The visible Chrome window's title on Windows, or undefined when none is found. */
export function windowsChromeTitle(
  env: NodeJS.ProcessEnv = process.env,
  testMode = false,
): string | undefined {
  if (env.AEON_CHROME_TITLE?.trim()) return env.AEON_CHROME_TITLE.trim();
  if (testMode) return undefined;
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1 -ExpandProperty MainWindowTitle",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 },
    );
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The avfoundation screen device index from `ffmpeg -f avfoundation -list_devices true -i ""`
 * (its stderr lists video devices such as "[1] Capture screen 0"). Cameras come first, so the
 * screen is rarely index 0.
 */
export function avfoundationScreenIndex(listing: string): string | undefined {
  return /\[(\d+)\]\s+Capture screen \d+/.exec(listing)?.[1];
}

/** avfoundation's input: AEON_MAC_SCREEN_DEVICE, else the first screen ffmpeg lists. It records a
 * whole screen; a single window cannot be selected, so `window` records the screen Chrome is on. */
export function macScreenDevice(
  ffmpeg: string,
  env: NodeJS.ProcessEnv = process.env,
  testMode = false,
): string {
  const override = env.AEON_MAC_SCREEN_DEVICE?.trim();
  if (override) return override.includes(":") ? override : `${override}:none`;
  if (testMode) return "1:none";
  let listing = "";
  try {
    execFileSync(
      ffmpeg,
      ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
      },
    );
  } catch (error) {
    // ffmpeg exits non-zero after listing (the empty input is not a device); the list is stderr.
    listing = String((error as { stderr?: unknown }).stderr ?? "");
  }
  const index = avfoundationScreenIndex(listing);
  if (!index)
    throw new Error(
      "No screen capture device found. Allow Screen Recording for your terminal in System Settings, or set AEON_MAC_SCREEN_DEVICE.",
    );
  return `${index}:none`;
}

/** ffmpeg arguments for the source: gdigrab on Windows, avfoundation on macOS, x11grab on Linux. */
export function captureArgs(
  state: RecordState,
  folder: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const out = join(folder, "frames", "%06d.jpg");
  const fps = String(state.fps);
  if (platform === "win32") {
    const select = state.input ?? gdigrabInput(state.source, undefined);
    return [
      "-v",
      "error",
      "-y",
      "-f",
      "gdigrab",
      "-framerate",
      fps,
      "-draw_mouse",
      "1",
      "-i",
      select,
      "-fps_mode",
      "cfr",
      "-r",
      fps,
      "-q:v",
      "2",
      out,
    ];
  }
  if (platform === "darwin") {
    const device = state.input ?? "1:none";
    return [
      "-v",
      "error",
      "-y",
      "-f",
      "avfoundation",
      "-framerate",
      fps,
      "-capture_cursor",
      "1",
      "-i",
      device,
      "-fps_mode",
      "cfr",
      "-r",
      fps,
      "-q:v",
      "2",
      out,
    ];
  }
  const d = state.display ?? display(true) ?? ":0";
  const screen = /^[^:]*:\d+\.\d+$/.test(d) ? d : `${d}.0`;
  const g = state.geometry ?? { x: 0, y: 0, ...screenSize(true) };
  return [
    "-v",
    "error",
    "-y",
    "-f",
    "x11grab",
    "-draw_mouse",
    "1",
    "-framerate",
    fps,
    "-video_size",
    `${g.w}x${g.h}`,
    "-i",
    `${screen}+${g.x},${g.y}`,
    "-fps_mode",
    "cfr",
    "-r",
    fps,
    "-q:v",
    "2",
    out,
  ];
}

export function loadState(folder: string): RecordState {
  try {
    return JSON.parse(readFileSync(join(folder, STATE), "utf8")) as RecordState;
  } catch {
    throw new Error(`No active recording in ${folder}. Run \`aeon record start\` first.`);
  }
}
export function saveState(folder: string, state: RecordState): void {
  writeFileSync(join(folder, STATE), JSON.stringify(state, null, 2));
}

function tabsState(folder: string, opts: RecordOptions): RecordState {
  mkdirSync(folder, { recursive: true });
  return {
    version: 1,
    source: "tabs",
    folder,
    fps: opts.fps ?? DEFAULT_FPS,
    startedAt: Date.now(),
    ffmpeg: "",
    tabSession: `aeon-record-${Date.now()}`,
    frames: 0,
  };
}

function sourceGeometry(opts: RecordOptions, testMode: boolean): RecordState["geometry"] {
  if (opts.source === "window" && isLinux) {
    const id = findChromeWindow(testMode);
    const geometry = testMode && !opts.ffmpeg ? undefined : windowGeometry(id, testMode);
    if (geometry && (geometry.w < 300 || geometry.h < 200))
      throw new Error("The Chrome window is too small to record; make it at least 300x200");
    return geometry;
  }
  if (opts.source === "screen") return { x: 0, y: 0, ...screenSize(testMode) };
  return undefined;
}

/** The platform's ffmpeg input, with an honest line when it records more than was asked for. */
function captureInput(opts: RecordOptions, ffmpeg: string, testMode: boolean): string | undefined {
  if (isWindows) {
    const input = gdigrabInput(opts.source, windowsChromeTitle(process.env, testMode));
    if (opts.source === "window" && input === "desktop")
      opts.log?.(
        "No Chrome window title found; recording the whole desktop. Set AEON_CHROME_TITLE to the exact window title to record only Chrome.",
      );
    return input;
  }
  if (isMac) {
    const device = macScreenDevice(ffmpeg, process.env, testMode);
    if (opts.source === "window")
      opts.log?.("macOS capture records the whole screen; keep Chrome in front.");
    return device;
  }
  return undefined;
}

function countFrames(folder: string): number {
  return readdirSync(join(folder, "frames")).filter((f) => f.endsWith(".jpg")).length;
}

async function waitForFrames(
  folder: string,
  testMode: boolean,
  child: { exitCode: number | null },
  errors: () => string,
): Promise<void> {
  const until = Date.now() + (testMode ? 2000 : 8000);
  while (Date.now() < until) {
    if (child.exitCode !== null && child.exitCode !== 0)
      throw new Error(
        `ffmpeg could not start: ${errors().trim().slice(-400) || `exit ${child.exitCode}`}`,
      );
    if (countFrames(folder) > 0) break;
    await sleep(50);
  }
}

/** Start capturing into `folder`. Resolves once frames are flowing (or the fake ffmpeg is up). */
export async function startCapture(folder: string, opts: RecordOptions): Promise<RecordState> {
  if (opts.source === "tabs") {
    const state = tabsState(folder, opts);
    saveState(folder, state);
    return state;
  }
  const testMode = opts.testMode ?? !!(opts.ffmpeg ?? process.env.AEON_FFMPEG);
  const d = display(testMode);
  if (isLinux && !d)
    throw new Error(
      "No X display. Start Xvfb and set DISPLAY, or record with --tabs (Aeon's hidden tab takes).",
    );
  const geometry = sourceGeometry(opts, testMode);
  mkdirSync(join(folder, "frames"), { recursive: true });
  const ffmpeg = ffmpegBinary(opts);
  const input = captureInput(opts, ffmpeg, testMode);
  const state: RecordState = {
    version: 1,
    source: opts.source,
    folder,
    fps: Math.max(5, Math.min(60, opts.fps ?? DEFAULT_FPS)),
    startedAt: Date.now(),
    ffmpeg,
    ...(d ? { display: d } : {}),
    ...(geometry ? { geometry } : {}),
    ...(input ? { input } : {}),
    frames: 0,
  };
  const child = spawn(ffmpeg, captureArgs(state, folder), {
    stdio: ["ignore", "ignore", "pipe"],
    detached: !testMode,
  });
  if (child.pid !== undefined) state.pid = child.pid;
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  child.on("error", (error) => {
    stderr += `\n${error.message}`;
  });
  saveState(folder, state);
  await waitForFrames(folder, testMode, child, () => stderr);
  state.frames = countFrames(folder);
  saveState(folder, state);
  return state;
}

/** Ask ffmpeg to finish (q via SIGINT, then TERM, then KILL) and encode clip.mp4 from the frames. */
export async function stopCapture(
  folder: string,
  opts: Partial<RecordOptions> = {},
): Promise<RecordState> {
  const state = loadState(folder);
  if (state.source === "tabs") {
    rmSync(join(folder, STATE), { force: true });
    return state;
  }
  if (state.pid) {
    const done = exited(state.pid);
    try {
      process.kill(state.pid, "SIGINT");
    } catch {
      // Already gone.
    }
    if (!(await done(5000))) {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    if (!(await done(2000))) {
      try {
        process.kill(state.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  const frames = readdirSync(join(folder, "frames"))
    .filter((f) => f.endsWith(".jpg"))
    .sort();
  if (!frames.length)
    throw new Error("The recording captured no frames. Was the window unminimized and visible?");
  state.frames = frames.length;
  const ffmpeg = opts.ffmpeg ?? state.ffmpeg;
  await run(ffmpeg, [
    "-v",
    "error",
    "-y",
    "-framerate",
    String(state.fps),
    "-i",
    join(folder, "frames", "%06d.jpg"),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(state.fps),
    join(folder, "clip.mp4"),
  ]).catch((error: Error) => {
    // A fake ffmpeg in tests exits 0 but writes nothing; keep the frames and the log anyway.
    if (!opts.ffmpeg) throw error;
  });
  rmSync(join(folder, STATE), { force: true });
  return state;
}

/** A reparented ffmpeg can be a zombie: kill(pid, 0) still succeeds, but it has already stopped. */
function alive(pid: number): boolean {
  if (isLinux) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
      return state !== "Z" && state !== "X";
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function exited(pid: number): (ms: number) => Promise<boolean> {
  return (ms) =>
    new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearInterval(check);
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => done(!alive(pid)), ms);
      const check = setInterval(() => {
        if (!alive(pid)) done(true);
      }, 40);
    });
}

function run(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (chunk) => (err += String(chunk)));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${binary} failed: ${err.slice(-300)}`)),
    );
  });
}

/** Best-effort frame size: ffprobe when available, else the first JPEG's SOF marker. */
export function frameSize(folder: string, probe: string): { width: number; height: number } {
  const frames = join(folder, "frames");
  // A recording that has not written its first frame yet (or a mode that writes no frames at all,
  // like --tabs) has no frames/ dir. That is not an error: report an unknown size instead.
  if (!existsSync(frames)) return { width: 0, height: 0 };
  const first = readdirSync(frames).find((f) => f.endsWith(".jpg"));
  if (!first) return { width: 0, height: 0 };
  const file = join(folder, "frames", first);
  try {
    const out = execFileSync(
      probe,
      ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", file],
      { encoding: "utf8" },
    );
    const [w, h] = out.trim().split(",").map(Number);
    if (w && h) return { width: w, height: h };
  } catch {
    // Fall through to parsing the JPEG header.
  }
  const bytes = readFileSync(file);
  for (let i = 2; i + 9 < bytes.length; i++) {
    const marker = bytes[i + 1] ?? -1;
    if (bytes[i] === 0xff && [0xc0, 0xc1, 0xc2, 0xc3].includes(marker)) {
      return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
    }
  }
  return { width: 0, height: 0 };
}

/** Where recordings live by default: a `recordings/` folder in the current directory. */
export function defaultFolder(out?: string): string {
  return out ?? join(process.cwd(), "recordings", new Date().toISOString().replace(/[:.]/g, "-"));
}

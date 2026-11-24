// Where a recording browser lives: setup-recording-chrome.sh saves each named browser's X display
// and devicePixelRatio, so `aeon record … --browser recording` needs no exported DISPLAY or
// AEON_RECORDING_DPR. --display always wins, then the environment, then the saved browser.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Args } from "browserkit/dist/args.js";
import { dataDirectory } from "./client.js";

export type SavedBrowser = { display?: string; dpr?: number };

export function browsersFile(): string {
  return join(dataDirectory(), "recordings", "browsers.json");
}

export function savedBrowser(name: string, file = browsersFile()): SavedBrowser | undefined {
  try {
    const all = JSON.parse(readFileSync(file, "utf8")) as Record<string, SavedBrowser>;
    const entry = all[name];
    return entry && typeof entry === "object" ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** A local display (`:120`) is live when its X socket exists; a remote one is trusted. */
export function displayLive(
  display: string,
  exists: (path: string) => boolean = existsSync,
): boolean {
  const local = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(display);
  return !local || exists(`/tmp/.X11-unix/X${local[1]}`);
}

/** The DISPLAY and AEON_RECORDING_DPR to record with; only what is missing is filled in. */
export function recordingEnv(
  flag: string | undefined,
  saved: SavedBrowser | undefined,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync,
): { DISPLAY?: string; AEON_RECORDING_DPR?: string } {
  const out: { DISPLAY?: string; AEON_RECORDING_DPR?: string } = {};
  if (flag) out.DISPLAY = flag;
  else if (!env.DISPLAY && saved?.display && displayLive(saved.display, exists))
    out.DISPLAY = saved.display;
  if (!env.AEON_RECORDING_DPR && saved?.dpr && saved.dpr > 0)
    out.AEON_RECORDING_DPR = String(saved.dpr);
  return out;
}

/**
 * Applies --display and the saved browser to this process, so xdotool, xwininfo and ffmpeg (all
 * children) and the events.json dpr see the same display and scale.
 */
export function useRecordingBrowser(args: Args, browser: string | undefined): void {
  const flag = typeof args.flags.display === "string" ? args.flags.display : undefined;
  const saved = browser && process.platform === "linux" ? savedBrowser(browser) : undefined;
  Object.assign(process.env, recordingEnv(flag, saved, process.env));
}

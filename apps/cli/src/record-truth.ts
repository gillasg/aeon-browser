// Clock and frame truth for a take: the real first-frame time, ffmpeg's dup/drop counts, and the
// deferred clip.mp4 encode that keeps stop off the critical path.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const PROGRESS_FILE = "capture.progress";

/** ffmpeg flags that write machine-readable progress (frame, dup_frames, drop_frames). */
export const progressArgs = (folder: string): string[] => [
  "-progress",
  join(folder, PROGRESS_FILE),
  "-stats_period",
  "1",
];

/** The last dup/drop counts in an ffmpeg -progress log. */
export function parseProgress(text: string): { dropped: number; dup: number } {
  let dropped = 0;
  let dup = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = /^(dup_frames|drop_frames)=(\d+)/.exec(line.trim());
    if (!m) continue;
    if (m[1] === "dup_frames") dup = Number(m[2]);
    else dropped = Number(m[2]);
  }
  return { dropped, dup };
}

export function readProgress(folder: string): { dropped: number; dup: number } | undefined {
  const path = join(folder, PROGRESS_FILE);
  if (!existsSync(path)) return undefined;
  return parseProgress(readFileSync(path, "utf8"));
}

/** First packet's wall-clock pts from `ffmpeg -v info` stderr (x11grab: `start: 1764…`). */
export function firstPacketMs(stderr: string): number | undefined {
  const m = /start:\s*(\d{9,}(?:\.\d+)?)/.exec(stderr);
  if (!m) return undefined;
  const ms = Number(m[1]) * 1000;
  return Number.isFinite(ms) ? ms : undefined;
}

/** mtime (epoch ms) of the first JPEG in frames/, if any. */
export function firstFrameMtime(folder: string): number | undefined {
  const dir = join(folder, "frames");
  if (!existsSync(dir)) return undefined;
  const first = readdirSync(dir)
    .filter((f) => f.endsWith(".jpg"))
    .sort()[0];
  return first ? statSync(join(dir, first)).mtimeMs : undefined;
}

/**
 * The clip's t=0: the first packet timestamp, else the first JPEG's mtime, never earlier than the
 * spawn (a pre-spawn clock makes every event lead the picture) and never in the future.
 */
export function trueT0(input: {
  spawnAt: number;
  now: number;
  packetMs?: number | undefined;
  mtimeMs?: number | undefined;
}): number {
  const ok = (v: number | undefined) =>
    v !== undefined && v >= input.spawnAt - 1 && v <= input.now + 1;
  const pick = [input.packetMs, input.mtimeMs].find(ok);
  return Math.round(pick ?? input.spawnAt);
}

/** Null when the take is honest; otherwise why it is refused. */
export function frameTruthError(clip: {
  frames: number;
  dropped?: number;
  dup?: number;
}): string | undefined {
  const bad = (clip.dropped ?? 0) + (clip.dup ?? 0);
  const share = bad / Math.max(1, clip.frames);
  if (share <= 0.005) return undefined;
  return `ffmpeg dropped ${clip.dropped ?? 0} and duplicated ${clip.dup ?? 0} of ${clip.frames} frames (${(share * 100).toFixed(2)}% > 0.5%): the picture stutters, so the take is refused. Lower --fps or DPR, or close other work.`;
}

/**
 * The exit code for a stopped take: a stuttering take fails by default (polished films stay
 * honest); with allowStutter (quick review clips on a busy machine) it is kept with a warning.
 */
export function stutterVerdict(
  clip: { frames: number; dropped?: number; dup?: number },
  allowStutter: boolean,
): { code: number; message?: string } {
  const refused = frameTruthError(clip);
  if (!refused) return { code: 0 };
  if (!allowStutter) return { code: 1, message: refused };
  const kept = refused.replace("so the take is refused", "kept anyway (--allow-stutter)");
  return {
    code: 0,
    message: `Warning: ${kept.split(". Lower")[0]}. Fine for review, not for a polished film.`,
  };
}

/** Encode clip.mp4 in the background at nice 19, so stop returns at once. */
export function deferEncode(ffmpeg: string, args: string[]): number | undefined {
  const nice = process.platform === "linux" && existsSync("/usr/bin/nice");
  const child = spawn(
    nice ? "/usr/bin/nice" : ffmpeg,
    nice ? ["-n", "19", ffmpeg, ...args] : args,
    {
      stdio: "ignore",
      detached: true,
    },
  );
  child.on("error", () => undefined);
  child.unref();
  return child.pid;
}

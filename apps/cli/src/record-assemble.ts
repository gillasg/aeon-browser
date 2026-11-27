// `graft record assemble <dir...>`: recording folders to one finished MP4 with pure ffmpeg, no
// Remotion and no headless Chrome. Takes are stitched in order with hard cuts, dead air is trimmed
// around real beats, the camera punches in on marked boxes (never past native pixels), a
// synthesized score is muxed as AAC, and an optional end card names the command and the repo.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Args } from "browserkit/dist/args.js";
import type { RecordingEvents } from "./record-events.js";
import {
  ffmpegArgs,
  keepSpans,
  beatsOf,
  assembleMeta,
  layout,
  scoreHits,
  totalMs,
  type AssembleOptions,
  type Segment,
  type Take,
} from "./record-assemble-plan.js";
import { encodeWav, synthesize } from "./record-score.js";
import { readMarks } from "./record-script.js";

export type AssembleRequest = Omit<AssembleOptions, "audio" | "drawtext"> & {
  dirs: string[];
  out: string;
  sound?: boolean;
  ffmpeg?: string;
  log?: (line: string) => void;
  /** Runs ffmpeg (tests pass a fake) and answers whether it has drawtext. */
  runner?: { run(bin: string, args: string[]): Promise<void>; drawtext(bin: string): boolean };
};

/** One recording folder: clip.mp4, events.json and (if stop has not merged them) marks.json. */
export function readTake(dir: string): Take {
  const clip = join(dir, "clip.mp4");
  const eventsFile = join(dir, "events.json");
  if (!existsSync(clip)) throw new Error(`${dir} has no clip.mp4 (is it a finished recording?)`);
  if (!existsSync(eventsFile)) throw new Error(`${dir} has no events.json`);
  const recording = JSON.parse(readFileSync(eventsFile, "utf8")) as RecordingEvents;
  const marks = recording.marks?.length ? recording.marks : readMarks(dir);
  return { clip, recording: { ...recording, events: recording.events ?? [] }, marks };
}

/** Whether this ffmpeg can draw text (some minimal builds lack drawtext). */
export function hasDrawtext(ffmpeg: string): boolean {
  const run = spawnSync(ffmpeg, ["-hide_banner", "-filters"], { encoding: "utf8" });
  return run.status === 0 && /\sdrawtext\s/.test(run.stdout ?? "");
}

function runFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (chunk: Buffer) => (err = (err + chunk.toString()).slice(-4000)));
    child.on("error", (error) => fail(new Error(`Could not run ${ffmpeg}: ${error.message}`)));
    child.on("close", (code) =>
      code === 0 ? done() : fail(new Error(`ffmpeg exited ${code}: ${err.trim()}`)),
    );
  });
}

export async function assemble(
  request: AssembleRequest,
): Promise<{ out: string; durationMs: number }> {
  const ffmpeg = request.ffmpeg ?? process.env.GRAFT_FFMPEG ?? "ffmpeg";
  const log = request.log ?? (() => undefined);
  const runner = request.runner ?? { run: runFfmpeg, drawtext: hasDrawtext };
  if (!request.dirs.length) throw new Error("assemble needs at least one recording folder");
  const takes = request.dirs.map(readTake);
  const segments = layout(
    takes.map((take) =>
      keepSpans(take.recording.clip.durationMs, beatsOf(take), request.maxIdleMs),
    ),
  );
  if (!segments.length) throw new Error("Every take is empty (durationMs 0): nothing to assemble");
  const endMs = request.end ? (request.endMs ?? 3000) : 0;
  const durationMs = totalMs(segments) + endMs;
  const temp = mkdtempSync(join(tmpdir(), "graft-assemble-"));
  try {
    const options = renderOptions(request, takes, segments, durationMs, temp, () =>
      runner.drawtext(ffmpeg),
    );
    if (request.end && !options.drawtext)
      log("This ffmpeg has no drawtext: the end card is plain.");
    await runner.run(ffmpeg, ffmpegArgs(takes, segments, request.out, options));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  log(
    `Assembled ${takes.length} take(s), ${segments.length} segment(s), ${(durationMs / 1000).toFixed(1)} s: ${request.out}`,
  );
  // Walkthrough cuts only: idle trims are unlabelled, so this output is never a house launch film.
  writeFileSync(`${request.out}.json`, JSON.stringify(assembleMeta(durationMs), null, 2) + "\n");
  return { out: request.out, durationMs };
}

/** The score and end-card text files, written into `temp`. */
function renderOptions(
  request: AssembleRequest,
  takes: Take[],
  segments: Segment[],
  durationMs: number,
  temp: string,
  drawtext: () => boolean,
): AssembleOptions {
  const options: AssembleOptions = { ...request, endMs: request.end ? (request.endMs ?? 3000) : 0 };
  if (request.sound) {
    options.audio = join(temp, "score.wav");
    writeFileSync(options.audio, encodeWav(synthesize(scoreHits(takes, segments), durationMs)));
  }
  if (request.end) options.end = withTextFiles(request.end, temp);
  options.drawtext = request.end ? drawtext() : false;
  return options;
}

function withTextFiles(
  end: NonNullable<AssembleOptions["end"]>,
  temp: string,
): NonNullable<AssembleOptions["end"]> {
  const write = (name: string, text: string | undefined) => {
    if (!text) return undefined;
    const file = join(temp, name);
    writeFileSync(file, text);
    return file;
  };
  const cmd = write("end-cmd.txt", end.cmd);
  const repo = write("end-repo.txt", end.repo);
  return { ...end, textFiles: { ...(cmd ? { cmd } : {}), ...(repo ? { repo } : {}) } };
}

const flag = (args: Args, name: string): string | undefined => {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
};

/** Output size, fps and the optional edits, read from flags. */
export function assembleOptionsOf(args: Args): Omit<AssembleRequest, "dirs" | "out"> {
  const idle = flag(args, "max-idle");
  const cmd = flag(args, "end-cmd");
  const repo = flag(args, "end-repo");
  const ffmpeg = flag(args, "ffmpeg");
  return {
    width: Number(flag(args, "width") ?? 1920),
    height: Number(flag(args, "height") ?? 1080),
    fps: Number(flag(args, "fps") ?? 30),
    ...(idle !== undefined ? { maxIdleMs: Number(idle) } : {}),
    ...(args.flags.zoom === true ? { zoom: true } : {}),
    ...(args.flags.sound === true ? { sound: true } : {}),
    ...(cmd || repo ? { end: { ...(cmd ? { cmd } : {}), ...(repo ? { repo } : {}) } } : {}),
    ...(ffmpeg ? { ffmpeg } : {}),
  };
}

export const ASSEMBLE_USAGE =
  'Usage: graft record assemble <dir...> [--out <file.mp4>] [--width 1920] [--height 1080] [--fps 30] [--max-idle <ms>] [--zoom] [--sound] [--end-cmd "<cmd>"] [--end-repo "<url>"] [--ffmpeg <bin>]';

export async function assembleCommand(args: Args, log: (line: string) => void): Promise<number> {
  const dirs = args.positional.slice(1).map((dir) => resolve(dir));
  if (!dirs.length) throw new Error(ASSEMBLE_USAGE);
  const out = resolve(flag(args, "out") ?? join(dirname(dirs[0] ?? "."), "walkthrough.mp4"));
  await assemble({ ...assembleOptionsOf(args), dirs, out, log });
  return 0;
}

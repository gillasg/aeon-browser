// `aeon film <clip.json>`: one command from plan to finished launch cut. Preflight → qualify
// check → shoot (stop defers clip.mp4) → automatic edit (the kit's autoEdit, from events.json
// alone) → house lint → 16:9 render + metadata JSON + contact sheet. The square cut and clip.mp4
// come after delivery, off the clock.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Args } from "browserkit/dist/args.js";
import type { DaemonHost } from "./host.js";
import { parseClip, planHash, qualified, readQualify, type ClipFile } from "./record-qualify.js";

export const FILM_USAGE =
  "Usage: aeon film <clip.json> --kit <video-kit dir> [--out <dir>] [--ffmpeg <bin>]";
export const FILM_STAGES = [
  "preflight",
  "qualify",
  "shoot",
  "edit",
  "lint",
  "render",
  "deliver",
] as const;
export type FilmStage = (typeof FILM_STAGES)[number];
/** Free space a 5-minute DPR 3 take needs (~6.7 GB) plus headroom. */
export const MIN_FREE_BYTES = 8 * 1024 ** 3;

/** director.json for a house film: overrides only; autoEdit and autoPair do the rest. */
export function directorFor(clip: ClipFile): Record<string, unknown> {
  return {
    house: true,
    surface: "obsidian",
    targetMs: clip.targetMs ?? 30_000,
    audioSrc: "audio/score.wav",
    ...(clip.end
      ? {
          end: {
            command: clip.end.command,
            repo: clip.end.repo ?? "github.com/gillasg/aeon-browser",
            durationMs: 2400,
          },
        }
      : {}),
  };
}

/** Why the film cannot start, checked before anything is filmed. */
export function preflight(input: {
  kit: string | undefined;
  kitReady: boolean;
  freeBytes: number;
  ffmpeg: boolean;
}): string[] {
  const out: string[] = [];
  if (!input.kit) out.push("--kit <dir> names the video kit (`aeon video kit <dir>`)");
  else if (!input.kitReady) out.push(`${input.kit} has no node_modules: run npm install there`);
  if (!input.ffmpeg) out.push("ffmpeg is not on PATH");
  if (input.freeBytes < MIN_FREE_BYTES)
    out.push(`${(input.freeBytes / 1024 ** 3).toFixed(1)} GB free; a take needs about 8 GB`);
  return out;
}

/** The contact sheet: one frame every 2 s, 480 px wide, tiled 4×3. */
export const contactSheetArgs = (video: string, png: string): string[] => [
  "-v",
  "error",
  "-y",
  "-i",
  video,
  "-vf",
  "fps=1/2,scale=480:-1,tile=4x3",
  "-frames:v",
  "1",
  png,
];

export type FilmDeps = {
  log(line: string): void;
  shoot(clip: ClipFile, dir: string): Promise<string[]>;
  run(cmd: string, args: string[], cwd?: string): number;
  copy(from: string, to: string): void;
  write(path: string, data: string): void;
  now(): number;
};

export async function film(
  clipPath: string,
  clip: ClipFile,
  options: { kit: string; out: string; ffmpeg: string },
  deps: FilmDeps,
): Promise<{ video: string; meta: string; sheet: string; stages: FilmStage[] }> {
  const stages: FilmStage[] = ["preflight"];
  const hash = planHash(clip);
  const q = qualified(readQualify(clipPath), hash, deps.now());
  if (!q.ok) throw new Error(`Not filming: ${q.why}`);
  stages.push("qualify");
  const takes = await deps.shoot(clip, join(options.out, "takes"));
  const take = takes[0];
  if (!take) throw new Error("The shoot produced no take");
  if (takes.length > 1) deps.log(`${takes.length} scenes shot; the film cuts the first (${take}).`);
  stages.push("shoot");
  deps.copy(join(take, "events.json"), join(options.kit, "src/recording.json"));
  deps.write(
    join(options.kit, "src/director.json"),
    JSON.stringify(directorFor(clip), null, 2) + "\n",
  );
  stages.push("edit", "lint");
  const video = join(options.out, "film.mp4");
  const status = deps.run(
    process.execPath,
    [
      "scripts/render.mjs",
      "DirectorCut",
      "--house",
      "--frames-dir",
      join(take, "frames"),
      "--out",
      video,
    ],
    options.kit,
  );
  if (status !== 0) throw new Error("The house lint or the render failed (see above)");
  stages.push("render");
  const sheet = join(options.out, "contact.png");
  deps.run(options.ffmpeg, contactSheetArgs(video, sheet));
  const meta = join(options.out, "film.json");
  deps.write(
    meta,
    JSON.stringify(
      { clip: resolve(clipPath), planHash: hash, lint: "on", house: true, take, video, sheet },
      null,
      2,
    ) + "\n",
  );
  stages.push("deliver");
  return { video, meta, sheet, stages };
}

const has = (bin: string) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0;

export async function filmCommand(host: DaemonHost, args: Args): Promise<number> {
  const file = args.positional[0];
  if (!file) throw new Error(FILM_USAGE);
  const kit = typeof args.flags.kit === "string" ? resolve(args.flags.kit) : undefined;
  const ffmpeg = typeof args.flags.ffmpeg === "string" ? args.flags.ffmpeg : "ffmpeg";
  const out = resolve(typeof args.flags.out === "string" ? args.flags.out : `film-${Date.now()}`);
  mkdirSync(out, { recursive: true });
  const fs = statfsSync(out);
  const problems = preflight({
    kit,
    kitReady: !!kit && existsSync(join(kit, "node_modules")),
    freeBytes: fs.bavail * fs.bsize,
    ffmpeg: has(ffmpeg),
  });
  const { log, recordSteps } = await import("./record-cmd.js");
  if (problems.length) {
    for (const p of problems) log(`preflight: ${p}`);
    return 1;
  }
  const clip = parseClip(JSON.parse(readFileSync(file, "utf8")));
  const { liveShootDeps } = await import("./record-shoot-cmd.js");
  const { shoot } = await import("./record-shoot.js");
  const steps = recordSteps(host);
  const takeArgs: Args = { positional: [], flags: { "defer-clip": true, "no-mouse": true } };
  const result = await film(
    file,
    clip,
    { kit: kit ?? ".", out, ffmpeg },
    {
      log,
      shoot: (c, dir) => shoot(c.plan, dir, liveShootDeps(host, steps, takeArgs)),
      run: (cmd, argv, cwd) => spawnSync(cmd, argv, { cwd, stdio: "inherit" }).status ?? 1,
      copy: copyFileSync,
      write: (p, d) => writeFileSync(p, d),
      now: Date.now,
    },
  );
  log(`Film: ${result.video}\nMetadata: ${result.meta}\nContact sheet: ${result.sheet}`);
  return 0;
}

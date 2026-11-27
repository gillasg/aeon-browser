// `graft film`: camera first. Preflight → qualify check → shoot (clip.mp4 deferred) → contact
// sheet from the raw frames → take.json, ready for any editor. With --kit (or `graft film render`)
// it also stages the take into an Open Studio kit and renders its Scene (or just --stills).
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

export const FILM_USAGE = `Usage: graft film [capture] <clip.json> [--out <dir>] [--kit <dir>] [--skip-qualify]
       [--stills 0,120] [--still-ms 0,2000] [--ffmpeg <bin>]
       graft film render --kit <dir> --take <take dir> [--stills ...] [--still-ms ...] [--out <file>]`;
export const FILM_STAGES = [
  "preflight",
  "qualify",
  "shoot",
  "contact",
  "render",
  "deliver",
] as const;
export type FilmStage = (typeof FILM_STAGES)[number];
/** Free space a 5-minute DPR 3 take needs (~6.7 GB) plus headroom. */
export const MIN_FREE_BYTES = 8 * 1024 ** 3;

export type RenderOptions = {
  stills?: string | undefined;
  stillMs?: string | undefined;
  out?: string;
};

/** Why the film cannot start, checked before anything is filmed. The kit is optional. */
export function preflight(input: {
  kit?: string | undefined;
  kitReady?: boolean;
  freeBytes: number;
  ffmpeg: boolean;
}): string[] {
  const out: string[] = [];
  if (input.kit && !input.kitReady)
    out.push(`${input.kit} has no node_modules: run npm install there`);
  if (!input.ffmpeg) out.push("ffmpeg is not on PATH");
  if (input.freeBytes < MIN_FREE_BYTES)
    out.push(`${(input.freeBytes / 1024 ** 3).toFixed(1)} GB free; a take needs about 8 GB`);
  return out;
}

/** The contact sheet from the raw frames: one every 2 s, 480 px wide, tiled 4×3. */
export const contactSheetArgs = (frames: string, png: string, fps = 30): string[] => [
  "-v",
  "error",
  "-y",
  "-framerate",
  String(fps),
  "-i",
  join(frames, "%06d.jpg"),
  "-vf",
  "fps=1/2,scale=480:-1,tile=4x3",
  "-frames:v",
  "1",
  png,
];

/** scripts/render.mjs arguments for a kit render of a take. */
export function renderArgs(take: string, out: string, o: RenderOptions): string[] {
  return [
    "scripts/render.mjs",
    "Scene",
    "--frames-dir",
    join(take, "frames"),
    "--out",
    out,
    ...(o.stills ? ["--stills", o.stills] : []),
    ...(o.stillMs ? ["--still-ms", o.stillMs] : []),
  ];
}

export type FilmDeps = {
  log(line: string): void;
  shoot(clip: ClipFile, dir: string): Promise<string[]>;
  run(cmd: string, args: string[], cwd?: string): number;
  copy(from: string, to: string): void;
  read(path: string): string;
  write(path: string, data: string): void;
  now(): number;
};

/** Stage a take into a kit (events.json → src/recording.json) and render its Scene. */
export function renderKit(
  kit: string,
  take: string,
  o: RenderOptions & { out: string },
  deps: Pick<FilmDeps, "run" | "copy">,
): string {
  deps.copy(join(take, "events.json"), join(kit, "src/recording.json"));
  const status = deps.run(process.execPath, renderArgs(take, o.out, o), kit);
  if (status !== 0) throw new Error("The kit render failed (see above)");
  return o.out;
}

const captureFps = (deps: FilmDeps, take: string): number => {
  try {
    return JSON.parse(deps.read(join(take, "events.json"))).clip?.fps || 30;
  } catch {
    return 30;
  }
};

export type FilmOptions = RenderOptions & {
  out: string;
  ffmpeg: string;
  kit?: string | undefined;
  skipQualify?: boolean;
};

export type FilmResult = {
  meta: string;
  contact: string;
  take: string;
  video: string | undefined;
  stages: FilmStage[];
};

export async function film(
  clipPath: string,
  clip: ClipFile,
  options: FilmOptions,
  deps: FilmDeps,
): Promise<FilmResult> {
  const stages: FilmStage[] = ["preflight"];
  const hash = planHash(clip);
  if (!options.skipQualify) {
    const q = qualified(readQualify(clipPath), hash, deps.now());
    if (!q.ok) throw new Error(`Not filming: ${q.why} (or pass --skip-qualify)`);
    stages.push("qualify");
  }
  const takes = await deps.shoot(clip, join(options.out, "takes"));
  const take = takes[0];
  if (!take) throw new Error("The shoot produced no take");
  if (takes.length > 1) deps.log(`${takes.length} scenes shot; take.json names the first.`);
  stages.push("shoot");
  const contact = join(options.out, "contact.png");
  const frames = join(take, "frames");
  deps.run(options.ffmpeg, contactSheetArgs(frames, contact, captureFps(deps, take)));
  stages.push("contact");
  let video: string | undefined;
  if (options.kit) {
    video = renderKit(options.kit, take, { ...options, out: join(options.out, "film.mp4") }, deps);
    stages.push("render");
  }
  const meta = join(options.out, "take.json");
  const body = {
    clip: resolve(clipPath),
    planHash: hash,
    qualified: !options.skipQualify,
    take,
    takes,
    frames,
    events: join(take, "events.json"),
    contact,
    ...(video ? { kit: options.kit, video } : {}),
  };
  deps.write(meta, JSON.stringify(body, null, 2) + "\n");
  stages.push("deliver");
  return { meta, contact, take, video, stages };
}

const has = (bin: string) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const liveRun = (cmd: string, argv: string[], cwd?: string) =>
  spawnSync(cmd, argv, { cwd, stdio: "inherit" }).status ?? 1;
const renderFlags = (args: Args): RenderOptions => ({
  stills: str(args.flags.stills),
  stillMs: str(args.flags["still-ms"]),
});

function renderCommand(args: Args, log: (line: string) => void): number {
  const kit = str(args.flags.kit);
  const take = str(args.flags.take);
  if (!kit || !take) throw new Error(FILM_USAGE);
  const out = resolve(str(args.flags.out) ?? join(kit, "out/Scene.mp4"));
  renderKit(
    resolve(kit),
    resolve(take),
    { ...renderFlags(args), out },
    {
      run: liveRun,
      copy: copyFileSync,
    },
  );
  log(`Rendered: ${out}`);
  return 0;
}

export async function filmCommand(host: DaemonHost, args: Args): Promise<number> {
  const { log, recordSteps } = await import("./record-cmd.js");
  const [sub, ...rest] = args.positional;
  if (sub === "render") return renderCommand(args, log);
  const file = sub === "capture" ? rest[0] : sub;
  if (!file) throw new Error(FILM_USAGE);
  const kitFlag = str(args.flags.kit);
  const kit = kitFlag ? resolve(kitFlag) : undefined;
  const ffmpeg = str(args.flags.ffmpeg) ?? "ffmpeg";
  const out = resolve(str(args.flags.out) ?? `film-${Date.now()}`);
  mkdirSync(out, { recursive: true });
  const fs = statfsSync(out);
  const problems = preflight({
    kit,
    kitReady: !!kit && existsSync(join(kit, "node_modules")),
    freeBytes: fs.bavail * fs.bsize,
    ffmpeg: has(ffmpeg),
  });
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
    { ...renderFlags(args), kit, out, ffmpeg, skipQualify: args.flags["skip-qualify"] === true },
    {
      log,
      shoot: (c, dir) => shoot(c.plan, dir, liveShootDeps(host, steps, takeArgs)),
      run: liveRun,
      copy: copyFileSync,
      read: (p) => readFileSync(p, "utf8"),
      write: (p, d) => writeFileSync(p, d),
      now: Date.now,
    },
  );
  log(`Take: ${result.take}\nContact sheet: ${result.contact}\nTake file: ${result.meta}`);
  if (result.video) log(`Film: ${result.video}`);
  return 0;
}

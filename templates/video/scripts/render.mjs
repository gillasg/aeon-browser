#!/usr/bin/env node
// Render any composition in src/Root.tsx (default Scene) to MP4, or just review stills.
// Usage: node scripts/render.mjs [Scene|RecordingRaw] [--out out/Scene.mp4] [--frames 0-59]
//   [--frames-dir <take/frames>] [--stills 0,120,300] [--still-ms 0,2000,6000]
// One Remotion bundle per kit hash (out/.bundle-<hash>), every core but one. --stills/--still-ms
// write <out dir>/stills/still-<frame>.png instead of the MP4. Writes <out>.json beside it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const list = (v) =>
  v === undefined
    ? undefined
    : String(v)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const n = Number(s);
          if (!Number.isFinite(n) || n < 0) throw new Error(`Not a frame or ms value: ${s}`);
          return n;
        });

/** argv → options. Throws on an unknown flag or a bad list. */
export function parseArgs(argv, kit = KIT) {
  const valued = new Set(["--out", "--frames", "--frames-dir", "--stills", "--still-ms"]);
  const flags = {};
  let id;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      id ??= a;
      continue;
    }
    if (!valued.has(a)) throw new Error(`Unknown flag ${a}`);
    flags[a] = argv[++i];
  }
  id ??= "Scene";
  return {
    id,
    out: resolve(flags["--out"] ?? join(kit, `out/${id}.mp4`)),
    frames: flags["--frames"],
    framesDir: flags["--frames-dir"] && resolve(flags["--frames-dir"]),
    stills: list(flags["--stills"]),
    stillMs: list(flags["--still-ms"]),
  };
}

/** The frames to still: explicit frames plus ms converted at the composition's fps. */
export const stillFrames = (o, fps, durationInFrames = Infinity) =>
  [
    ...new Set([
      ...(o.stills ?? []),
      ...(o.stillMs ?? []).map((ms) => Math.round((ms * fps) / 1000)),
    ]),
  ]
    .map((f) => Math.min(Math.floor(f), Math.max(0, durationInFrames - 1)))
    .sort((a, b) => a - b);

export const stillPath = (out, frame) => join(dirname(out), "stills", `still-${frame}.png`);

/** Hash of everything the bundle is built from (src/, package.json), not public/. */
function kitHash(kit) {
  const h = createHash("sha256");
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(relative(kit, p)).update(readFileSync(p));
    }
  };
  walk(join(kit, "src"));
  h.update(readFileSync(join(kit, "package.json")));
  return h.digest("hex").slice(0, 16);
}

async function bundleOnce(kit) {
  const dir = join(kit, `out/.bundle-${kitHash(kit)}`);
  if (existsSync(join(dir, "index.html"))) return dir;
  const { bundle } = await import("@remotion/bundler");
  return bundle({
    entryPoint: join(kit, "src/Root.tsx"),
    outDir: dir,
    publicDir: join(kit, "public"),
  });
}

const run = (kit, cmd, argv) => {
  const r = spawnSync(cmd, argv, { cwd: kit, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

export async function main(argv, kit = KIT) {
  const o = parseArgs(argv, kit);
  const stillsWanted = !!(o.stills || o.stillMs);
  if (o.framesDir) {
    const { stageFrames } = await import(pathToFileURL(join(kit, "src/frames.ts")).href);
    console.log(`staged ${stageFrames(o.framesDir, join(kit, "public/frames"))} frame(s)`);
  }
  mkdirSync(dirname(o.out), { recursive: true });
  const concurrency = Math.max(1, cpus().length - 1);
  const started = Date.now();
  let meta = { composition: o.id };
  let stills;
  try {
    const { renderMedia, renderStill, selectComposition } = await import("@remotion/renderer");
    const serveUrl = await bundleOnce(kit);
    const composition = await selectComposition({ serveUrl, id: o.id });
    const { width, height, fps, durationInFrames } = composition;
    meta = { ...meta, width, height, fps, durationInFrames };
    if (stillsWanted) {
      stills = [];
      for (const frame of stillFrames(o, fps, durationInFrames)) {
        const output = stillPath(o.out, frame);
        mkdirSync(dirname(output), { recursive: true });
        await renderStill({ serveUrl, composition, frame, output, imageFormat: "png" });
        stills.push(output);
      }
    } else {
      const range = o.frames?.split("-").map(Number);
      await renderMedia({
        serveUrl,
        composition,
        codec: "h264",
        crf: 16,
        outputLocation: o.out,
        concurrency,
        logLevel: "error",
        ...(range ? { frameRange: range.length === 1 ? range[0] : [range[0], range[1]] } : {}),
      });
    }
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    // No @remotion/renderer installed: the CLI renders the same composition (bundles per call).
    if (stillsWanted) {
      stills = [];
      // ms need the fps; the CLI path assumes the Scene default of 60.
      for (const frame of stillFrames(o, 60)) {
        const output = stillPath(o.out, frame);
        run(kit, "npx", ["remotion", "still", "src/Root.tsx", o.id, output, `--frame=${frame}`]);
        stills.push(output);
      }
    } else
      run(kit, "npx", [
        "remotion",
        "render",
        "src/Root.tsx",
        o.id,
        o.out,
        "--codec=h264",
        "--crf=16",
        "--log=error",
        `--concurrency=${concurrency}`,
        ...(o.frames ? [`--frames=${o.frames}`] : []),
      ]);
  }
  const sidecar = { ...meta, elapsedMs: Date.now() - started, ...(stills ? { stills } : {}) };
  writeFileSync(`${o.out}.json`, JSON.stringify(sidecar, null, 2) + "\n");
  for (const line of stills ?? [o.out]) console.log(line);
  return sidecar;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

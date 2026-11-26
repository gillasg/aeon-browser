#!/usr/bin/env node
// Lint, score, then render. Usage: node scripts/render.mjs [DirectorCut|DirectorSquare|RecordingRaw]
//   [--out out/director.mp4] [--no-lint] [--house] [--no-audio] [--frames 0-59] [--frames-dir <take/frames>]
// One Remotion bundle per kit hash (cached under out/.bundle-<hash>), renderMedia on every core
// but one, 16:9 first. --frames-dir hardlinks only the frames the edit references into public/.
// Writes <out>.json beside the video with the composition, "lint": "on" | "off" and "house".
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { formatLint, lintEdit } from "../src/lint.ts";
import { referencedFrames } from "../src/frames.ts";
import { KIT, loadEdits } from "./load-edit.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const id =
  args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? "DirectorCut";
const out = resolve(flag("--out") ?? join(KIT, `out/${id}.mp4`));
const lint = has("--no-lint") ? "off" : "on";
const house = has("--house");

const { edits } = loadEdits();
const edit = edits[id];
if (lint === "on" && edit) {
  const result = lintEdit(edit, { house });
  console.log(formatLint(result));
  if (!result.ok) {
    console.error("Refusing to render. Fix the edit, or pass --no-lint (stamped in the metadata).");
    process.exit(1);
  }
}
const run = (cmd, argv) => {
  const r = spawnSync(cmd, argv, { cwd: KIT, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

/** Hardlink (else copy) just the frames the edit shows into public/frames. */
function stageFrames(from) {
  const dir = join(KIT, "public/frames");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const names = edit ? referencedFrames(edit) : readdirSync(from).filter((f) => f.endsWith(".jpg"));
  for (const f of names) {
    const src = join(from, f);
    if (!existsSync(src)) continue;
    try {
      linkSync(src, join(dir, f));
    } catch {
      copyFileSync(src, join(dir, f));
    }
  }
  console.log(`staged ${names.length} frame(s)`);
}

/** Hash of everything the bundle is built from (src/, package.json), not public/. */
function kitHash() {
  const h = createHash("sha256");
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(relative(KIT, p)).update(readFileSync(p));
    }
  };
  walk(join(KIT, "src"));
  h.update(readFileSync(join(KIT, "package.json")));
  return h.digest("hex").slice(0, 16);
}

async function bundleOnce() {
  const dir = join(KIT, `out/.bundle-${kitHash()}`);
  if (existsSync(join(dir, "index.html"))) return dir;
  const { bundle } = await import("@remotion/bundler");
  return bundle({
    entryPoint: join(KIT, "src/Root.tsx"),
    outDir: dir,
    publicDir: join(KIT, "public"),
  });
}

const framesDir = flag("--frames-dir");
if (framesDir) stageFrames(resolve(framesDir));
if (id !== "RecordingRaw" && !has("--no-audio"))
  run(process.execPath, ["scripts/generate-audio.mjs"]);
mkdirSync(dirname(out), { recursive: true });
const frames = flag("--frames");
const started = Date.now();
try {
  const { renderMedia, selectComposition } = await import("@remotion/renderer");
  const serveUrl = await bundleOnce();
  const composition = await selectComposition({ serveUrl, id });
  const range = frames?.split("-").map(Number);
  await renderMedia({
    serveUrl,
    composition,
    codec: "h264",
    crf: 16,
    outputLocation: out,
    concurrency: Math.max(1, cpus().length - 1),
    logLevel: "error",
    ...(range ? { frameRange: range.length === 1 ? range[0] : [range[0], range[1]] } : {}),
  });
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  // No @remotion/renderer installed: the CLI renders the same composition (bundles per call).
  run("npx", [
    "remotion",
    "render",
    "src/Root.tsx",
    id,
    out,
    "--codec=h264",
    "--crf=16",
    "--log=error",
    `--concurrency=${Math.max(1, cpus().length - 1)}`,
    ...(frames ? [`--frames=${frames}`] : []),
  ]);
}
writeFileSync(
  `${out}.json`,
  JSON.stringify(
    {
      composition: id,
      lint,
      house,
      renderMs: Date.now() - started,
      renderedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
console.log(out);

#!/usr/bin/env node
// Lint, score, then render. Usage: node scripts/render.mjs [DirectorCut|DirectorSquare|RecordingRaw]
//   [--out out/director.mp4] [--no-lint] [--no-audio] [--frames 0-59]
// Writes <out>.json beside the video with the composition and "lint": "on" | "off".
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { formatLint, lintEdit } from "../src/lint.ts";
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

const { edits } = loadEdits();
if (lint === "on" && edits[id]) {
  const result = lintEdit(edits[id]);
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
if (id !== "RecordingRaw" && !has("--no-audio"))
  run(process.execPath, ["scripts/generate-audio.mjs"]);
mkdirSync(dirname(out), { recursive: true });
const frames = flag("--frames");
run("npx", [
  "remotion",
  "render",
  "src/Root.tsx",
  id,
  out,
  "--codec=h264",
  "--crf=16",
  "--log=error",
  ...(frames ? [`--frames=${frames}`] : []),
]);
writeFileSync(
  `${out}.json`,
  JSON.stringify({ composition: id, lint, renderedAt: new Date().toISOString() }, null, 2) + "\n",
);
console.log(out);

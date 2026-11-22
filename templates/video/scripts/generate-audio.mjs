#!/usr/bin/env node
// Synthesize the score (48 kHz, 16-bit stereo WAV) from events.json + director.json. Offline,
// deterministic, no audio assets. Usage: node scripts/generate-audio.mjs [--out public/audio/score.wav]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { editDuration } from "../src/edit.ts";
import { encodeWav, scoreFor, synthesize } from "../src/sound.ts";
import { KIT, loadEdits } from "./load-edit.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = resolve(flag("--out") ?? join(KIT, "public/audio/score.wav"));
const { recording, edits } = loadEdits(flag("--events"), flag("--director"));
const edit = edits.DirectorCut;
const score = scoreFor(edit, recording, editDuration(edit));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, encodeWav(synthesize(score)));
const counts = score.hits.reduce((m, h) => ((m[h.kind] = (m[h.kind] ?? 0) + 1), m), {});
console.log(
  `score: ${out} (${(score.durationMs / 1000).toFixed(2)} s, ${JSON.stringify(counts)}, ${score.hums.length} hum)`,
);

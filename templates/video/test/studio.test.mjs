// The open studio: recording.ts timing helpers and render.mjs argument parsing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const kit = fileURLToPath(new URL("..", import.meta.url));
const load = (p) => import(pathToFileURL(join(kit, p)).href);

const json = {
  version: 1,
  recorder: "graft",
  clock: "clip",
  clip: {
    file: "clip.mp4",
    source: "window",
    width: 3840,
    height: 2160,
    fps: 30,
    startedAt: 0,
    durationMs: 6000,
    frames: 180,
  },
  events: [
    { id: "r2", kind: "beat", t: 5000, at: 5000, beat: "receipt" },
    { id: "c", kind: "click", t: 100, at: 100 },
    { id: "r1", kind: "beat", t: 3000, at: 3000, beat: "receipt" },
    { id: "s", kind: "beat", t: 1000, at: 1000, beat: "send" },
  ],
};

test("recording.ts: msToFrame, frameFile, frameAt and beatTime snap to real timestamps", async () => {
  const { frameFile, loadRecording } = await load("src/recording.ts");
  const take = loadRecording(json, { fps: 60 });
  assert.equal(take.msToFrame(1000), 60);
  assert.equal(take.msToFrame(-5), 0);
  assert.equal(take.frameToMs(90), 1500);
  assert.equal(take.durationInFrames, 360);
  assert.equal(frameFile(0), "000001.jpg");
  assert.equal(take.frameFile(179), "000180.jpg");
  assert.deepEqual(take.frameAt(1000), { index: 30, t: 1000, file: "000031.jpg" });
  assert.equal(take.frameAt(99_000).file, "000180.jpg", "clamped to the last frame");
  assert.equal(take.beatTime("receipt"), 3000);
  assert.equal(take.beatTime("receipt", 1), 5000);
  assert.equal(take.beatTime("handoff"), undefined);
  assert.deepEqual(
    take.beats.map((b) => b.id),
    ["s", "r1", "r2"],
  );
  assert.equal(loadRecording(json).fps, 30, "fps defaults to the capture's");
  assert.equal(take.width, 3840);
});

test("render.mjs: Scene by default, stills and frames-dir parsed, no lint refusal", async () => {
  const { parseArgs, stillFrames, stillPath } = await load("scripts/render.mjs");
  const o = parseArgs([], "/kit");
  assert.equal(o.id, "Scene");
  assert.equal(o.out, resolve("/kit", "out/Scene.mp4"));
  assert.equal(o.stills, undefined);
  const s = parseArgs(
    ["RecordingRaw", "--stills", "0,120", "--still-ms", "2000,500", "--frames-dir", "/t/frames"],
    "/kit",
  );
  assert.equal(s.id, "RecordingRaw");
  assert.deepEqual(s.stills, [0, 120]);
  assert.deepEqual(s.stillMs, [2000, 500]);
  assert.equal(s.framesDir, resolve("/t", "frames"));
  assert.deepEqual(stillFrames(s, 60), [0, 30, 120]);
  assert.deepEqual(stillFrames({ stills: [999] }, 60, 100), [99]);
  assert.equal(stillPath("/o/film.mp4", 30), join("/o", "stills", "still-30.png"));
  assert.throws(() => parseArgs(["--stills", "a"]), /Not a frame/);
  assert.throws(() => parseArgs(["--house"]), /Unknown flag/);
  const src = readFileSync(join(kit, "scripts/render.mjs"), "utf8");
  assert.ok(!/lint|generate-audio|director\.json/i.test(src));
});

test("Scene.tsx exports sceneConfig and Root registers Scene and RecordingRaw", () => {
  const scene = readFileSync(join(kit, "src/Scene.tsx"), "utf8");
  assert.match(scene, /export const sceneConfig/);
  assert.match(scene, /width: 1920/);
  const root = readFileSync(join(kit, "src/Root.tsx"), "utf8");
  assert.match(root, /id="Scene"/);
  assert.match(root, /id="RecordingRaw"/);
});

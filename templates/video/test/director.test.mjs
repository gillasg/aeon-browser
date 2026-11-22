// Director's Studio: the physical curve, the native-pixel invariant, scanline alignment, the
// taste linter and the synthesized score.
import assert from "node:assert/strict";
import test from "node:test";
import { camAt, ease, fromEvents, maxZoom, requestedZoom } from "../src/camera.ts";
import { buildEdit, DIRECTOR_CUT, DIRECTOR_SQUARE, editDuration } from "../src/edit.ts";
import { lintEdit } from "../src/lint.ts";
import { pairLayout, scanlinePad } from "../src/pair.ts";
import { encodeWav, SAMPLE_RATE, scoreFor, synthesize } from "../src/sound.ts";

const src = { width: 3840, height: 2160, dpr: 3 };
const out = { width: 1920, height: 1080 };
const recording = (events = [], extra = {}) => ({
  version: 1,
  recorder: "aeon",
  clock: "clip",
  clip: {
    file: "clip.mp4",
    source: "window",
    width: 3840,
    height: 2160,
    fps: 30,
    startedAt: 0,
    durationMs: 6000,
    frames: 1,
    dpr: 3,
  },
  events,
  ...extra,
});
const click = (t, box, beat) => ({
  id: `e${t}`,
  kind: "click",
  t,
  at: t,
  box,
  ...(beat ? { beat } : {}),
});

test("ease is cubic-bezier(0.16, 1, 0.3, 1): monotonic, no overshoot, dead stop", () => {
  let prev = 0;
  for (let i = 0; i <= 200; i++) {
    const y = ease(i / 200);
    assert.ok(y >= prev - 1e-9 && y <= 1 + 1e-9, `step ${i}: ${y}`);
    prev = y;
  }
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.ok(ease(0.25) > 0.6, "decisive launch");
});

test("native-pixel invariant: a 3x master allows 2x into 1080p, and the camera never exceeds it", () => {
  assert.equal(maxZoom(src, out), 2);
  const cue = {
    tStart: 0,
    tEnd: 2000,
    framing: "focus",
    focusRect: { x: 1900, y: 1000, w: 40, h: 20 },
  };
  assert.ok(requestedZoom(cue, src, out) <= 1.85);
  const cam = camAt([{ ...cue, scale: 4 }], 1000, src, out);
  assert.ok(cam.z <= 2 + 1e-9, `z=${cam.z}`);
});

test("fromEvents pushes in on real element bounds and keeps every move out of holds", () => {
  const events = [click(1000, { x: 340, y: 170, width: 600, height: 48 })];
  const cues = fromEvents(events, src);
  assert.equal(cues.length, 1);
  assert.deepEqual(cues[0].focusRect, { x: 1020, y: 510, w: 1800, h: 144 });
  assert.ok(cues[0].tStart < 1000 && cues[0].tEnd > 1000);
  const held = fromEvents(events, src, { holds: [{ tStart: 1800, tEnd: 3600 }] });
  assert.equal(held[0].tEnd, 3600, "the pull-out waits for the hold to end");
  const mid = camAt(held, 2000, src, out, { holds: [{ tStart: 1800, tEnd: 3600 }] });
  const late = camAt(held, 3500, src, out, { holds: [{ tStart: 1800, tEnd: 3600 }] });
  assert.deepEqual(mid, late, "the camera is locked through the hold");
});

test("Pair puts the returned line on the page value's scanline", () => {
  const { browser, terminal } = pairLayout(out, 1);
  assert.ok(Math.abs(browser.x + browser.w - 1920 * 0.58) < 40);
  assert.ok(terminal.x > browser.x + browser.w);
  const cam = camAt([], 0, src, { width: browser.w, height: browser.h }, { rest: "stage" });
  const lineHeight = 68;
  const r = scanlinePad({ pageY: 1401, cam, src, browser, terminal, lineHeight, line: 2 });
  assert.ok(r.aligned);
  const lineCenter = terminal.y + r.pad + 2 * lineHeight + lineHeight / 2;
  assert.ok(Math.abs(lineCenter - r.y) < 1e-6, "same pixel row");
  const high = scanlinePad({ pageY: 0, cam, src, browser, terminal, lineHeight, line: 12 });
  assert.equal(high.aligned, false);
  assert.equal(high.pad, 0);
});

test("lint passes a clean edit and fails each kind of slop", () => {
  const clean = buildEdit(
    recording([click(1000, { x: 340, y: 350, width: 600, height: 60 }, "receipt")]),
    {},
    DIRECTOR_CUT,
  );
  assert.deepEqual(lintEdit(clean).issues, []);
  const rules = (edit) => new Set(lintEdit(edit).issues.map((i) => i.rule));

  const upscale = {
    ...clean,
    cues: [
      {
        tStart: 0,
        tEnd: 500,
        framing: "focus",
        focusRect: { x: 0, y: 0, w: 100, h: 100 },
        scale: 2.4,
      },
    ],
  };
  assert.ok(rules(upscale).has("upscale"));
  const lowRes = { ...clean, source: { ...clean.source, width: 1280, height: 720 } };
  assert.ok(rules(lowRes).has("upscale"));

  const tiny = {
    ...clean,
    cues: [],
    beats: [{ t: 500, beat: "receipt", box: { x: 0, y: 0, w: 100, h: 30 } }],
  };
  assert.ok(rules(tiny).has("phone-floor"));

  const moving = {
    ...clean,
    holds: [{ tStart: 1000, tEnd: 2800 }],
    cues: [{ tStart: 1500, tEnd: 4000, framing: "stage" }],
  };
  assert.ok(rules(moving).has("hold"));
  const cutInHold = {
    ...clean,
    holds: [{ tStart: 1000, tEnd: 2800 }],
    cues: [],
    segments: [
      { s0: 0, s1: 2000, speed: 1 },
      { s0: 4000, s1: 6000, speed: 1 },
    ],
  };
  assert.ok(rules(cutInHold).has("hold"));

  const ramp = { ...clean, segments: [{ s0: 0, s1: 6000, speed: 4 }] };
  assert.ok(rules(ramp).has("speed-label"));
  assert.ok(
    !rules({ ...ramp, segments: [{ s0: 0, s1: 6000, speed: 4, label: "4×" }] }).has("speed-label"),
  );

  const wordy = {
    ...clean,
    editorial: [{ tStart: 0, tEnd: 1000, text: "This is way too many words here" }],
  };
  assert.ok(rules(wordy).has("editorial"));
  assert.ok(
    rules({ ...clean, editorial: [{ tStart: 0, tEnd: 1, text: "Truly revolutionary" }] }).has(
      "editorial",
    ),
  );
  assert.ok(
    rules({ ...clean, slides: [{ text: "See it happen", durationMs: 1200 }] }).has("slide"),
  );
  for (const fx of ["blur", "tilt", "glow", "overshoot"])
    assert.ok(rules({ ...clean, effects: [fx] }).has("effect"), fx);
  assert.ok(
    rules({ ...clean, cues: [{ tStart: 0, tEnd: 900, framing: "stage", easeMs: 200 }] }).has(
      "ease",
    ),
  );
});

test("the shipped fixture lints clean in both cuts", async () => {
  const { loadEdits } = await import("../scripts/load-edit.mjs");
  const { edits } = loadEdits();
  for (const edit of Object.values(edits)) assert.deepEqual(lintEdit(edit).issues, []);
  assert.equal(edits.DirectorSquare.output.width, DIRECTOR_SQUARE.width);
});

test("the score is a valid 48 kHz stereo WAV: keys, trigger, hum, chord, then silence", () => {
  const rec = recording([click(3000, undefined, "receipt")], {
    soundCues: [
      { t: 500, kind: "key" },
      { t: 555, kind: "key" },
      { t: 2000, kind: "trigger" },
      { t: 3500, kind: "key" },
    ],
  });
  const edit = buildEdit(rec, { compile: [{ tStart: 1000, tEnd: 2000 }] });
  const score = scoreFor(edit, rec, editDuration(edit));
  assert.deepEqual(
    score.hits.map((h) => h.kind),
    ["key", "key", "trigger", "chord"],
    "the key inside the hold is silenced",
  );
  const bus = synthesize(score);
  const again = synthesize(score);
  assert.deepEqual(bus.l.slice(0, 48_000), again.l.slice(0, 48_000), "deterministic");
  const at = (ms) => Math.round((ms / 1000) * SAMPLE_RATE);
  const peak = (a, b) => bus.l.slice(at(a), at(b)).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak(1700, 1990) > 0.01, "hum during compile");
  assert.ok(peak(2030, 2990) < 1e-6, "vacuum after Enter");
  assert.ok(peak(3000, 3100) > 0.05, "arrival chord");
  assert.ok(peak(4300, 4700) < 1e-3, "silence through the hold");
  const wav = encodeWav(bus);
  const view = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), "WAVE");
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(wav.length, 44 + bus.l.length * 4);
});

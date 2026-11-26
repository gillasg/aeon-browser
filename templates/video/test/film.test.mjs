// The automatic edit, the house grammar, the Pair's provenance join and the dot-matrix theme.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { autoEdit, autoPair, pairMoment, SPEED_LADDER, speedFor } from "../src/auto.ts";
import { fromEvents } from "../src/camera.ts";
import { glyphDots, hasGlyph, INK, revealAt, scanlineDots, waveAt } from "../src/dotmatrix.ts";
import { buildEdit, DIRECTOR_CUT, END_COMMAND } from "../src/edit.ts";
import { referencedFrames } from "../src/frames.ts";
import { lintEdit } from "../src/lint.ts";
import { cutTimes, maxCutsInWindow, movesPerBeat } from "../src/lint-house.ts";
import { NOTES } from "../src/sound.ts";
import { stripAnsi, streamJsonLines } from "../src/terminal.ts";
import { videoLength } from "../src/timeline.ts";

const clip = (durationMs, extra = {}) => ({
  file: "clip.mp4",
  source: "window",
  width: 3840,
  height: 2160,
  fps: 30,
  startedAt: 0,
  durationMs,
  frames: Math.round((durationMs / 1000) * 30),
  dpr: 3,
  ...extra,
});
const beat = (t, name, more = {}) => ({ id: `b${t}`, kind: "beat", t, at: t, beat: name, ...more });
const rec = (durationMs, events, extra = {}) => ({
  version: 1,
  recorder: "aeon",
  clock: "clip",
  clip: clip(durationMs, extra.clip),
  events,
  ...extra.rest,
});
const box = { x: 340, y: 350, width: 600, height: 60 };

test("autoEdit: a 300 s take becomes ≤ 30 s, real time on the beats, every speed labelled", () => {
  const events = [
    beat(10_000, "summon", { box }),
    beat(11_000, "send", { box }),
    beat(250_000, "receipt", { box, text: "0.4 s · via API" }),
  ];
  const segs = autoEdit(rec(300_000, events), 30_000);
  assert.ok(videoLength(segs) <= 30_000, `${videoLength(segs)} ms`);
  for (const s of segs)
    if (s.speed !== 1) {
      assert.ok(SPEED_LADDER.includes(s.speed));
      assert.equal(s.label, `${s.speed}×`);
    }
  const at = (t) => segs.find((s) => t >= s.s0 && t <= s.s1);
  assert.equal(at(250_500).speed, 1, "the receipt hold is real time");
  assert.equal(at(10_000).speed, 1, "the summon is real time");
  for (let i = 1; i < segs.length; i++)
    assert.equal(segs[i].s0, segs[i - 1].s1, "no cuts in a take");
  assert.equal(segs[0].s0, 0);
  assert.equal(segs.at(-1).s1, 300_000);
});

test("autoEdit leaves a short take whole, and speedFor picks the smallest ladder step", () => {
  assert.deepEqual(autoEdit(rec(6000, [beat(1000, "receipt")])), [{ s0: 0, s1: 6000, speed: 1 }]);
  assert.equal(speedFor(10_000, 20_000), 1);
  assert.equal(speedFor(30_000, 10_000), 3);
  assert.equal(speedFor(1e9, 1), 64);
});

test("the camera moves only on story beats, never on plain agent clicks", () => {
  const src = { width: 3840, height: 2160, dpr: 3 };
  const click = { id: "c", kind: "click", t: 1000, at: 1000, box };
  assert.equal(fromEvents([click], src).length, 0);
  assert.equal(fromEvents([{ ...click, beat: "summon" }], src).length, 1);
});

test("Pair: reveals on learned and joins by provenance bounds, surfacing aligned", () => {
  const recording = rec(
    8000,
    [beat(3000, "learned"), beat(2000, "provenance", { box, jsonPath: "$.items[0].title" })],
    {
      rest: { align: { text: "Sony", via: "provenance", aligned: true, box, line: 2 } },
    },
  );
  assert.equal(pairMoment(recording), 3000);
  const pair = autoPair(recording, { x: 3, y: 3 });
  assert.equal(pair.aligned, true);
  assert.equal(pair.via, "provenance");
  assert.equal(pair.alignPageY, (350 + 30) * 3);
  assert.equal(pair.alignTerminalLine, 2);
  const term = rec(8000, [], {
    rest: {
      terminal: {
        version: 1,
        command: "x",
        startedAt: 0,
        events: [{ t: 4200, kind: "out", text: "Learned on hn\n" }],
      },
    },
  });
  assert.equal(pairMoment(term), 4200);
});

const houseRules = (edit) => new Set(lintEdit(edit, { house: true }).issues.map((i) => i.rule));
const houseEdit = (script = {}, extra = {}) =>
  buildEdit(
    rec(6000, [beat(1000, "receipt", { box })], extra),
    { house: true, ...script },
    DIRECTOR_CUT,
  );

test("house lint keeps EditorialBeat and passes a clean edit", () => {
  const edit = houseEdit({ editorial: [{ tStart: 3000, tEnd: 4000, text: "Any site. An API." }] });
  assert.deepEqual(lintEdit(edit).issues, []);
  assert.ok(!houseRules(edit).has("editorial"));
  assert.equal(houseRules(edit).size, 0, [...houseRules(edit)].join(","));
});

test("house lint fails *.example End hosts, unaligned Pairs, DPR < 3, dirty and stuttering takes", () => {
  assert.ok(
    houseRules(
      houseEdit({ end: { command: "aeon mcp shop.example", repo: "r", durationMs: 1 } }),
    ).has("end-host"),
  );
  assert.ok(houseRules(houseEdit({ pair: { pairAtMs: 4000, aligned: false } })).has("aligned"));
  assert.ok(houseRules(houseEdit({ pair: { pairAtMs: 4000 } })).has("aligned"));
  const soft = houseEdit();
  assert.ok(houseRules({ ...soft, source: { ...soft.source, dpr: 2 } }).has("dpr"));
  assert.ok(houseRules(houseEdit({}, { clip: { clean: false } })).has("clean"));
  assert.ok(houseRules(houseEdit({}, { clip: { dropped: 5, dup: 0 } })).has("dup-drop"));
  const back = houseEdit({
    segments: [
      { s0: 0, s1: 3000, speed: 1 },
      { s0: 2000, s1: 6000, speed: 1 },
    ],
  });
  assert.ok(houseRules(back).has("monotonic"));
  assert.ok(
    !lintEdit(houseEdit({ end: { command: "x.example", repo: "", durationMs: 1 } }), {
      house: false,
    }).issues.some((i) => i.rule === "end-host"),
  );
});

test("house lint counts cuts per 20 s and moves per beat", () => {
  const segs = Array.from({ length: 6 }, (_, i) => ({
    s0: i * 1000,
    s1: i * 1000 + 500,
    speed: 1,
  }));
  const edit = { ...houseEdit(), segments: segs };
  assert.equal(maxCutsInWindow(cutTimes(edit)), 5);
  assert.ok(houseRules(edit).has("cuts"));
  const twitchy = {
    ...houseEdit(),
    cues: [
      { tStart: 2000, tEnd: 2500, framing: "stage" },
      { tStart: 3000, tEnd: 3500, framing: "stage" },
    ],
  };
  assert.deepEqual(movesPerBeat(twitchy), [0, 2]);
  assert.ok(houseRules(twitchy).has("moves"));
});

test("the End default never names an npx command", () => {
  const edit = buildEdit(rec(1000, []));
  assert.equal(edit.end.command, END_COMMAND);
  assert.ok(!/npx/.test(edit.end.command));
});

test("dot-matrix: 5×7 glyphs, reveal sweep, wave and scanline", () => {
  const one = glyphDots("1");
  assert.equal(one.cols, 5);
  assert.equal(one.rows, 7);
  assert.equal(one.dots.length, 1 + 2 + 1 + 1 + 1 + 1 + 3);
  assert.equal(glyphDots("3×").cols, 11);
  assert.ok(hasGlyph("×") && hasGlyph("s") && !hasGlyph("~"));
  assert.equal(revealAt(0, 10, 10), 0);
  assert.equal(revealAt(1000, 10, 10), 1);
  for (const v of [0, 300, 900].map((ms) => waveAt(ms, 3, 4)))
    assert.ok(v >= 0.1 && v <= 0.28 + 1e-9);
  assert.deepEqual(scanlineDots(10, 34, 8), [10, 18, 26, 34]);
  assert.equal(INK.void, "#000000");
});

test("theme files use only the monochrome palette (amber only for hand-off)", () => {
  for (const f of [
    "Stage.tsx",
    "EditorialBeat.tsx",
    "TimeCut.tsx",
    "Pair.tsx",
    "End.tsx",
    "DotMatrix.tsx",
    "DirectorCut.tsx",
  ]) {
    const text = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    const hexes = (text.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).map((h) => h.toUpperCase());
    for (const h of hexes)
      assert.ok(
        ["#000000", "#F3F3F1", "#8A8A88", "#ECEAE4", "#141518", "#F5A623"].includes(h),
        `${f}: ${h}`,
      );
  }
});

test("score notes are Aeon's own (orb-sounds.ts)", () => {
  const src = readFileSync(
    new URL("../../../apps/chrome-extension/src/orb/orb-sounds.ts", import.meta.url),
    "utf8",
  );
  for (const [name, notes] of Object.entries(NOTES))
    assert.ok(src.includes(`${name}: [${notes.join(", ")}]`), name);
});

test("terminal: ANSI stripped, stream-JSON rendered as readable rows", () => {
  assert.equal(stripAnsi("\u001b[1mbold\u001b[0m\rdone"), "done");
  assert.equal(stripAnsi("a\u001b[32mb\u001b[0m"), "ab");
  const rows = streamJsonLines(
    [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "aeon mcp hn" } }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Learned on hn" }] },
      }),
      "not json",
      JSON.stringify({ type: "result", result: "3 rows", duration_ms: 4200 }),
    ].join("\n"),
  );
  assert.deepEqual(rows, ["› Bash aeon mcp hn", "Learned on hn", "3 rows", "4.2 s"]);
});

test("frames staging references only what the edit shows", () => {
  const edit = buildEdit(rec(300_000, [beat(10_000, "receipt", { box })]), { targetMs: 20_000 });
  const names = referencedFrames(edit);
  assert.ok(names.length < 900 && names.length > 100, String(names.length));
});

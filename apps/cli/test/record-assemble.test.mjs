// `aeon record assemble`: idle-trim math, the native-pixel zoom clamp, the filtergraph, multi-take
// concat args, the WAV score, and a run end to end against a fake ffmpeg.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  beatsOf,
  ffmpegArgs,
  filterPath,
  fitSize,
  keepSpans,
  layout,
  maxZoom,
  mergeSpans,
  scoreHits,
  toOutput,
  totalMs,
  zoomFor,
  zoompanFilter,
  zoomWindows,
  HOLD_MS,
  LEAD_MS,
  TAIL_MS,
} from "../dist/record-assemble-plan.js";
import { assemble, assembleOptionsOf, readTake } from "../dist/record-assemble.js";
import { encodeWav, hitKind, SAMPLE_RATE, synthesize } from "../dist/record-score.js";

const clip = (durationMs, width = 2560, height = 1440) => ({
  file: "clip.mp4",
  source: "window",
  width,
  height,
  fps: 30,
  startedAt: 0,
  durationMs,
  frames: 1,
  dpr: 2,
});
const take = (durationMs, events = [], marks = [], extra = {}) => ({
  clip: "/takes/a/clip.mp4",
  recording: {
    version: 1,
    recorder: "aeon",
    clock: "clip",
    clip: clip(durationMs),
    events,
    ...extra,
  },
  marks,
});
const OUT = { width: 1920, height: 1080 };

test("without --max-idle the whole clip is kept", () => {
  assert.deepEqual(keepSpans(10_000, [{ t: 5000 }]), [{ start: 0, end: 10_000 }]);
  assert.deepEqual(keepSpans(10_000, [], 500), [{ start: 0, end: 10_000 }]);
  assert.deepEqual(keepSpans(0, [{ t: 1 }], 500), []);
});

test("--max-idle cuts only stillness longer than the limit", () => {
  const spans = keepSpans(60_000, [{ t: 10_000 }, { t: 11_000 }, { t: 40_000 }], 2000);
  assert.deepEqual(spans, [
    { start: 0, end: LEAD_MS },
    { start: 10_000 - LEAD_MS, end: 11_000 + TAIL_MS },
    { start: 40_000 - LEAD_MS, end: 40_000 + TAIL_MS },
    { start: 60_000 - TAIL_MS, end: 60_000 },
  ]);
  // A short gap is joined, not cut.
  const joined = keepSpans(10_000, [{ t: 2000 }, { t: 5000 }], 5000);
  assert.deepEqual(joined, [{ start: 0, end: 10_000 }]);
});

test("arrivals and receipts keep a still hold after them", () => {
  const [, beat] = keepSpans(30_000, [{ t: 10_000, hold: true }], 100);
  assert.deepEqual(beat, { start: 10_000 - LEAD_MS, end: 10_000 + HOLD_MS });
  const beats = beatsOf(
    take(
      30_000,
      [{ id: "1", kind: "click", t: 100, at: 0, beat: "receipt" }],
      [
        { name: "arrive", t: 200 },
        { name: "cart", t: 300, cue: "arrive" },
        { name: "plain", t: 400 },
      ],
    ),
  );
  assert.deepEqual(
    beats.map((b) => b.hold === true),
    [true, true, true, false],
  );
});

test("mergeSpans joins overlaps and close gaps", () => {
  assert.deepEqual(
    mergeSpans(
      [
        { start: 5, end: 9 },
        { start: 0, end: 4 },
      ],
      1,
    ),
    [{ start: 0, end: 9 }],
  );
  assert.deepEqual(
    mergeSpans([
      { start: 5, end: 9 },
      { start: 0, end: 4 },
    ]),
    [
      { start: 0, end: 4 },
      { start: 5, end: 9 },
    ],
  );
});

test("layout places takes end to end and maps clip time onto the output", () => {
  const segs = layout([
    [
      { start: 0, end: 1000 },
      { start: 5000, end: 6000 },
    ],
    [{ start: 0, end: 500 }],
  ]);
  assert.deepEqual(
    segs.map((s) => [s.take, s.at]),
    [
      [0, 0],
      [0, 1000],
      [1, 2000],
    ],
  );
  assert.equal(totalMs(segs), 2500);
  assert.equal(toOutput(segs, 0, 5500), 1500);
  assert.equal(toOutput(segs, 0, 3000), undefined);
  assert.equal(toOutput(segs, 1, 100), 2100);
});

test("zoom never shows a source pixel larger than an output pixel", () => {
  assert.ok(Math.abs(maxZoom({ width: 2560, height: 1440 }, OUT) - 4 / 3) < 1e-9);
  assert.equal(maxZoom({ width: 3840, height: 2160 }, OUT), 2);
  assert.equal(maxZoom({ width: 1280, height: 720 }, OUT), 1);
  const tiny = { x: 100, y: 100, width: 10, height: 10 };
  assert.ok(zoomFor(tiny, { width: 2560, height: 1440 }, OUT) <= 4 / 3 + 1e-9);
  assert.equal(zoomFor(tiny, { width: 1280, height: 720 }, OUT), 1);
  assert.equal(
    zoomFor({ x: 0, y: 0, width: 2000, height: 1200 }, { width: 2560, height: 1440 }, OUT),
    1,
  );
});

test("small sources are padded, never upscaled", () => {
  assert.deepEqual(fitSize({ width: 1280, height: 720 }, OUT), { width: 1280, height: 720 });
  assert.deepEqual(fitSize({ width: 2560, height: 1440 }, OUT), OUT);
  assert.deepEqual(fitSize({ width: 2561, height: 1441 }, OUT).width % 2, 0);
});

test("zoom windows sit on the segment's clock and do not overlap", () => {
  const source = { width: 2560, height: 1440 };
  const beats = [
    { t: 2000, box: { x: 100, y: 100, width: 200, height: 100 } },
    { t: 3000, box: { x: 1000, y: 600, width: 200, height: 100 } },
    { t: 9000, box: { x: 0, y: 0, width: 50, height: 50 } },
  ];
  const windows = zoomWindows({ start: 1000, end: 8000 }, beats, source, OUT);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].start, 1000 - 260);
  assert.ok(windows[0].end <= windows[1].start);
  for (const w of windows) assert.ok(w.z <= 4 / 3 + 1e-9 && w.z > 1);
  const filter = zoompanFilter(windows, source, OUT, 30);
  assert.match(filter, /^zoompan=z='1\+/);
  assert.match(filter, /:d=1:s=1920x1080:fps=30$/);
  assert.match(filter, /clip\(/);
  assert.equal(zoompanFilter([], source, OUT, 30), undefined);
});

test("multi-take args seek each segment and concat them with hard cuts", () => {
  const a = { ...take(20_000), clip: join("takes", "a", "clip.mp4") };
  const b = { ...take(5000), clip: join("takes", "b", "clip.mp4") };
  const segs = layout([
    [
      { start: 0, end: 1000 },
      { start: 4000, end: 6500 },
    ],
    [{ start: 0, end: 5000 }],
  ]);
  const args = ffmpegArgs([a, b], segs, "out.mp4", { ...OUT, fps: 30 });
  assert.deepEqual(args.slice(-1), ["out.mp4"]);
  const inputs = args.flatMap((v, i) => (v === "-i" ? [args[i + 1]] : []));
  assert.deepEqual(inputs, [a.clip, a.clip, b.clip]);
  assert.equal(args[args.indexOf("-ss", args.indexOf("-ss") + 1) + 1], "4");
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.match(graph, /\[v0\]\[v1\]\[v2\]concat=n=3:v=1:a=0\[vout\]$/);
  assert.match(graph, /pad=1920:1080:\(ow-iw\)\/2:\(oh-ih\)\/2:color=0x0B0C0F/);
  for (const flag of ["libx264", "superfast", "18", "yuv420p", "+faststart", "-an"])
    assert.ok(args.includes(flag), flag);
  assert.ok(!graph.includes("zoompan"));
});

test("sound and end card join the graph", () => {
  const t = take(
    3000,
    [],
    [{ name: "x", t: 100, windowBox: { x: 10, y: 10, width: 100, height: 50 } }],
  );
  const segs = layout([[{ start: 0, end: 3000 }]]);
  const args = ffmpegArgs([t], segs, "o.mp4", {
    ...OUT,
    fps: 30,
    zoom: true,
    audio: "score.wav",
    drawtext: true,
    endMs: 2000,
    end: { cmd: "npx aeon", textFiles: { cmd: "C:\\tmp\\cmd.txt" } },
  });
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.match(graph, /zoompan=/);
  assert.match(graph, /color=c=0x0B0C0F:s=1920x1080:r=30:d=2/);
  assert.match(graph, /textfile='C\\:\/tmp\/cmd.txt'/);
  assert.match(graph, /\[v0\]\[v1\]concat=n=2/);
  assert.deepEqual(
    args.slice(
      args.indexOf("-map", args.indexOf("[vout]")),
      args.indexOf("-map", args.indexOf("[vout]")) + 2,
    ),
    ["-map", "1:a"],
  );
  assert.ok(args.includes("aac") && args.includes("128k"));
  const plain = ffmpegArgs([t], segs, "o.mp4", {
    ...OUT,
    fps: 30,
    drawtext: false,
    end: { cmd: "x" },
  });
  assert.ok(!plain[plain.indexOf("-filter_complex") + 1].includes("drawtext"));
});

test("filterPath escapes Windows drive colons and backslashes", () => {
  assert.equal(filterPath("C:\\Users\\a b\\x.txt"), "C\\:/Users/a b/x.txt");
  assert.equal(filterPath("/tmp/x.txt"), "/tmp/x.txt");
});

test("score hits follow cuts onto the output clock", () => {
  const t = take(
    20_000,
    [
      { id: "1", kind: "type", t: 1000, at: 0, text: "ab" },
      { id: "2", kind: "click", t: 9000, at: 0 },
      { id: "3", kind: "click", t: 15_000, at: 0, beat: "receipt" },
    ],
    [{ name: "arrive", t: 15_100, cue: "arrive" }],
  );
  const segs = layout([
    [
      { start: 0, end: 2000 },
      { start: 14_000, end: 20_000 },
    ],
  ]);
  const hits = scoreHits([t], segs);
  assert.deepEqual(
    hits.map((h) => [h.t, h.kind]),
    [
      [1000, "key"],
      [1055, "key"],
      [3000, "trigger"],
      [3000, "chord"],
      [3100, "note"],
    ],
  );
  assert.equal(hitKind("shutter"), "trigger");
  assert.equal(hitKind("done"), "chord");
});

test("the WAV is 48 kHz 16-bit stereo, deterministic and not silent", () => {
  const hits = [
    { t: 10, kind: "key" },
    { t: 100, kind: "trigger" },
    { t: 200, kind: "chord" },
    { t: 400, kind: "note" },
  ];
  const bus = synthesize(hits, 1000);
  assert.equal(bus.l.length, SAMPLE_RATE);
  const wav = encodeWav(bus);
  const view = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(wav.length, 44 + SAMPLE_RATE * 4);
  assert.deepEqual(encodeWav(synthesize(hits, 1000)), wav);
  assert.ok(bus.l.some((v) => Math.abs(v) > 0.01));
});

test("flags become assemble options", () => {
  const o = assembleOptionsOf({
    positional: [],
    flags: {
      "max-idle": "1500",
      zoom: true,
      sound: true,
      "end-cmd": "npx aeon",
      width: "1280",
      height: "720",
    },
  });
  assert.deepEqual(o, {
    width: 1280,
    height: 720,
    fps: 30,
    maxIdleMs: 1500,
    zoom: true,
    sound: true,
    end: { cmd: "npx aeon" },
  });
});

test("assemble reads folders, writes the score and runs ffmpeg once", async () => {
  const root = mkdtempSync(join(tmpdir(), "aeon-assemble-test-"));
  try {
    const dirs = ["a", "b"].map((name, i) => {
      const dir = join(root, name);
      mkdirSync(dir);
      writeFileSync(join(dir, "clip.mp4"), "");
      writeFileSync(join(dir, "events.json"), JSON.stringify(take(4000 + i * 1000).recording));
      return dir;
    });
    writeFileSync(join(dirs[1], "marks.json"), JSON.stringify([{ name: "m", t: 10, cue: "key" }]));
    assert.equal(readTake(dirs[1]).marks.length, 1);
    const calls = [];
    const runner = {
      drawtext: () => false,
      run: async (bin, args) => {
        const wav = args.find((a) => a.endsWith("score.wav"));
        calls.push({ bin, args, wav: readFileSync(wav).length });
      },
    };
    const out = join(root, "out.mp4");
    const lines = [];
    const result = await assemble({
      dirs,
      out,
      ...OUT,
      fps: 30,
      sound: true,
      end: { cmd: "npx aeon" },
      ffmpeg: "ffmpeg-x",
      log: (l) => lines.push(l),
      runner,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, "ffmpeg-x");
    assert.equal(result.durationMs, 4000 + 5000 + 3000);
    assert.equal(calls[0].wav, 44 + Math.round(12 * 48_000) * 4);
    assert.ok(lines.some((l) => /no drawtext/.test(l)));
    assert.ok(lines.some((l) => /Assembled 2 take/.test(l)));
    await assert.rejects(
      assemble({
        dirs,
        out,
        ...OUT,
        fps: 30,
        runner: {
          drawtext: () => true,
          run: async () => {
            throw new Error("boom");
          },
        },
      }),
      /boom/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing clip is a clear error", () => {
  const root = mkdtempSync(join(tmpdir(), "aeon-assemble-test-"));
  try {
    assert.throws(() => readTake(root), /no clip\.mp4/);
    writeFileSync(join(root, "clip.mp4"), "");
    assert.throws(() => readTake(root), /no events\.json/);
    assert.ok(readFileSync(join(root, "clip.mp4"), "utf8") === "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

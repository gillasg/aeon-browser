// Clock and frame truth, the beat bus, director steps, the scanline join, qualify and `aeon film`.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { align } from "../dist/record-align.js";
import { assembleMeta } from "../dist/record-assemble-plan.js";
import { beatSeen, withBeats } from "../dist/record-beats.js";
import { captureArgs } from "../dist/record-capture.js";
import { eventsFromTrace, soundCuesFromEvents, STORY_BEATS } from "../dist/record-events.js";
import { parsePlan } from "../dist/record-shoot.js";
import { ptySpawn } from "../dist/record-terminal.js";
import {
  checkRun,
  parseClip,
  planHash,
  qualified,
  qualify,
  today,
} from "../dist/record-qualify.js";
import { frameTruthError, parseProgress, progressArgs, trueT0 } from "../dist/record-truth.js";
import { contactSheetArgs, film, preflight, renderArgs, renderKit } from "../dist/film-cmd.js";

test("t0 is the first frame, never before the spawn", () => {
  assert.equal(trueT0({ spawnAt: 1000, now: 1500, mtimeMs: 1180 }), 1180);
  assert.equal(trueT0({ spawnAt: 1000, now: 1500, packetMs: 1100, mtimeMs: 1180 }), 1100);
  assert.equal(trueT0({ spawnAt: 1000, now: 1500, mtimeMs: 900 }), 1000, "a stale file is ignored");
  assert.equal(trueT0({ spawnAt: 1000, now: 1500 }), 1000);
});

test("dup/drop counts come from -progress, and a take over 0.5% is refused", () => {
  const log =
    "frame=10\ndup_frames=0\ndrop_frames=0\nprogress=continue\nframe=900\ndup_frames=3\ndrop_frames=4\nprogress=end\n";
  assert.deepEqual(parseProgress(log), { dropped: 4, dup: 3 });
  assert.equal(frameTruthError({ frames: 9000, dropped: 20, dup: 20 }), undefined);
  assert.match(frameTruthError({ frames: 900, dropped: 4, dup: 3 }), /refused/);
  const state = {
    version: 1,
    source: "window",
    folder: "/r",
    fps: 30,
    startedAt: 0,
    ffmpeg: "ffmpeg",
    frames: 0,
    display: ":1",
    geometry: { x: 0, y: 0, w: 10, h: 10 },
  };
  for (const platform of ["linux", "darwin", "win32"]) {
    const args = captureArgs(state, "/r", platform).join(" ");
    assert.ok(args.includes(progressArgs("/r").join(" ")), platform);
  }
});

test("beat bus: film actions become beat events and real-key sound cues", () => {
  assert.deepEqual(
    [...STORY_BEATS],
    [
      "summon",
      "key",
      "send",
      "teach",
      "learned",
      "receipt",
      "handoff",
      "resume",
      "sound",
      "provenance",
    ],
  );
  const trace = {
    trace: [
      {
        actions: [
          { kind: "film", beat: "summon", tStart: 1100, box: { x: 1, y: 2, width: 3, height: 4 } },
          { kind: "film", beat: "key", tStart: 1200 },
          { kind: "film", beat: "key", tStart: 1290 },
          { kind: "film", beat: "send", tStart: 1400, text: "find it" },
          { kind: "film", beat: "sound", cue: "done", tStart: 1900 },
          { kind: "film", beat: "bogus", tStart: 1950 },
          { kind: "film", beat: "receipt", tStart: 500 },
        ],
      },
    ],
  };
  const events = eventsFromTrace(trace, 1000);
  assert.deepEqual(
    events.map((e) => e.beat),
    ["summon", "key", "key", "send", "sound"],
  );
  assert.equal(events[0].kind, "beat");
  assert.deepEqual(events[0].box, { x: 1, y: 2, width: 3, height: 4 });
  assert.deepEqual(
    soundCuesFromEvents(events).map((c) => [c.t, c.kind]),
    [
      [200, "key"],
      [290, "key"],
      [400, "trigger"],
      [900, "done"],
    ],
  );
  const merged = withBeats(
    [{ id: "e1", kind: "click", t: 50, at: 1050 }],
    trace.trace[0].actions,
    1000,
  );
  assert.equal(merged[0].kind, "click");
  assert.ok(beatSeen(trace.trace[0].actions, "send", 1300));
  assert.ok(!beatSeen(trace.trace[0].actions, "send", 1500));
});

test("director steps parse; reset is prepare-only; wait beat is not", () => {
  const plan = parsePlan({
    scenes: [
      {
        name: "a",
        prepare: [{ reset: "news.ycombinator.com", boost: true }],
        steps: [
          { type: "hello" },
          { press: "Return" },
          { wait: "beat", beat: "receipt" },
          { wait: "chat", chat: "latest" },
          { align: "Sony", line: 2 },
        ],
      },
    ],
  });
  assert.deepEqual(plan.scenes[0].steps[0], { type: "hello", actor: "director" });
  assert.deepEqual(plan.scenes[0].steps[1], { press: "Return", actor: "director" });
  assert.deepEqual(plan.scenes[0].prepare[0], { reset: "news.ycombinator.com", boost: true });
  assert.throws(
    () => parsePlan({ scenes: [{ name: "a", steps: [{ reset: "x.com" }] }] }),
    /prepare only/,
  );
  assert.throws(
    () =>
      parsePlan({
        scenes: [{ name: "a", prepare: [{ wait: "beat", beat: "receipt" }], steps: [] }],
      }),
    /before the camera/,
  );
  assert.throws(
    () => parsePlan({ scenes: [{ name: "a", steps: [{ press: "rm -rf" }] }] }),
    /press/,
  );
});

test("align: provenance first, exact text second, aligned false otherwise", () => {
  const box = { x: 10, y: 20, width: 100, height: 18 };
  const terminal = {
    version: 1,
    command: "aeon call",
    startedAt: 0,
    events: [
      { t: 0, kind: "in", text: "aeon call" },
      { t: 5, kind: "out", text: '\u001b[32m{\n  "title": "Sony"\n}\u001b[0m\n' },
    ],
  };
  const prov = align(
    {
      events: [
        { id: "p", kind: "beat", t: 1, at: 1, beat: "provenance", box, jsonPath: "$.title" },
      ],
      terminal,
    },
    "Sony",
  );
  assert.equal(prov.via, "provenance");
  assert.equal(prov.aligned, true);
  assert.equal(prov.line, 2);
  const byText = align(
    { events: [{ id: "c", kind: "click", t: 1, at: 1, text: "Sony", box }], terminal },
    "Sony",
  );
  assert.equal(byText.via, "text");
  assert.equal(byText.aligned, true);
  const none = align({ events: [], terminal }, "Missing");
  assert.equal(none.aligned, false);
});

test("terminal runs under a PTY on Linux when script exists", () => {
  assert.equal(ptySpawn("ls", "linux", true).cmd, "/usr/bin/script");
  assert.deepEqual(ptySpawn("ls", "darwin", true), { cmd: "ls", args: [], shell: true });
  assert.equal(ptySpawn("ls", "linux", false).shell, true);
});

test("assemble output is stamped house false", () => {
  assert.deepEqual(assembleMeta(1000), { kind: "walkthrough", house: false, durationMs: 1000 });
});

const clipJson = {
  scenes: [{ name: "boost", steps: [{ open: "https://news.ycombinator.com" }] }],
  expect: { receipt: "Boost on", maxSeconds: 1 },
  end: { command: "aeon boosts", repo: "github.com/gillasg/aeon-browser" },
};
const take = (text, clean = true) => ({
  version: 1,
  recorder: "aeon",
  clock: "clip",
  clip: { clean },
  events: [{ beat: "receipt", text }],
});

test("qualify: three passes in a row, same plan, same day", async () => {
  const clip = parseClip(clipJson);
  assert.deepEqual(checkRun([take("0.4 s · Boost on")], clip.expect), []);
  assert.equal(checkRun([take("2.4 s · Boost on")], clip.expect).length, 1);
  assert.equal(checkRun([take("0.4 s · Boost on", false)], clip.expect).length, 1);
  const hash = planHash(clip);
  assert.equal(
    hash,
    planHash(parseClip({ ...clipJson, out: "elsewhere" })),
    "paths do not change the hash",
  );
  let n = 0;
  const now = Date.UTC(2026, 10, 25, 12);
  const deps = {
    shoot: async () => [`t${++n}`],
    read: () => take("0.4 s · Boost on"),
    now: () => now,
    log: () => undefined,
  };
  const file = await qualify(clip, "/q", 3, deps);
  assert.equal(file.runs.length, 3);
  assert.equal(file.date, today(now));
  assert.ok(qualified(file, hash, now).ok);
  assert.equal(qualified(file, "other", now).ok, false);
  assert.equal(qualified(file, hash, now + 86_400_000).ok, false);
  const flaky = await qualify(clip, "/q", 3, { ...deps, read: () => take("9 s · Boost on") });
  assert.equal(flaky.runs.length, 1, "one failure ends the series");
  assert.equal(qualified(flaky, hash, now).ok, false);
});

const filmDeps = (dir, ran, written) => ({
  log: () => undefined,
  shoot: async () => [join(dir, "takes/01-boost")],
  run: (cmd, args, cwd) => (ran.push({ line: [cmd, ...args].join(" "), cwd }), 0),
  copy: (from, to) => written.push(["copy", from, to]),
  read: () => JSON.stringify({ clip: { fps: 60 } }),
  write: (p, d) => writeFileSync(p, d),
  now: () => Date.now(),
});
const qualifyFile = (dir, clip) =>
  writeFileSync(
    join(dir, "qualify.json"),
    JSON.stringify({
      planHash: planHash(clip),
      date: today(),
      runs: [1, 2, 3].map(() => ({ ok: true, reasons: [], ms: 1 })),
    }),
  );

test("aeon film: camera only, no kit: qualify, shoot, raw contact sheet, take.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aeon-film-"));
  try {
    const clipPath = join(dir, "clip.json");
    writeFileSync(clipPath, JSON.stringify(clipJson));
    const clip = parseClip(clipJson);
    const ran = [];
    const written = [];
    const deps = filmDeps(dir, ran, written);
    const options = { out: dir, ffmpeg: "ffmpeg" };
    await assert.rejects(film(clipPath, clip, options, deps), /Not filming/);
    qualifyFile(dir, clip);
    const result = await film(clipPath, clip, options, deps);
    assert.deepEqual(result.stages, ["preflight", "qualify", "shoot", "contact", "deliver"]);
    assert.equal(ran.length, 1, "no kit, no render");
    assert.ok(ran[0].line.includes("tile=4x3"));
    assert.ok(ran[0].line.includes("-framerate 60"));
    assert.ok(ran[0].line.includes(join(dir, "takes/01-boost/frames/%06d.jpg")));
    assert.equal(written.length, 0);
    const meta = JSON.parse(readFileSync(result.meta, "utf8"));
    assert.equal(meta.frames, join(dir, "takes/01-boost/frames"));
    assert.equal(meta.events, join(dir, "takes/01-boost/events.json"));
    assert.equal(meta.contact, join(dir, "contact.png"));
    assert.equal(meta.planHash, planHash(clip));
    assert.equal(meta.video, undefined);
    assert.ok(!existsSync(join(dir, "src/director.json")));
    const skipped = await film(clipPath, clip, { ...options, skipQualify: true }, deps);
    assert.ok(!skipped.stages.includes("qualify"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aeon film --kit stages the take and renders Scene, forwarding stills", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aeon-film-"));
  try {
    const clipPath = join(dir, "clip.json");
    writeFileSync(clipPath, JSON.stringify(clipJson));
    const clip = parseClip(clipJson);
    qualifyFile(dir, clip);
    const kit = join(dir, "kit");
    const ran = [];
    const written = [];
    const options = { kit, out: dir, ffmpeg: "ffmpeg", stills: "0,120", stillMs: "2000" };
    const result = await film(clipPath, clip, options, filmDeps(dir, ran, written));
    assert.deepEqual(result.stages, [
      "preflight",
      "qualify",
      "shoot",
      "contact",
      "render",
      "deliver",
    ]);
    const render = ran.find((r) => r.line.includes("scripts/render.mjs"));
    assert.equal(render.cwd, kit);
    assert.ok(render.line.includes("scripts/render.mjs Scene --frames-dir"));
    assert.ok(render.line.includes("--stills 0,120 --still-ms 2000"));
    assert.ok(!/house|DirectorCut|lint/.test(render.line));
    assert.deepEqual(written[0].slice(1), [
      join(dir, "takes/01-boost/events.json"),
      join(kit, "src/recording.json"),
    ]);
    assert.equal(JSON.parse(readFileSync(result.meta, "utf8")).video, join(dir, "film.mp4"));
    assert.throws(
      () => renderKit(kit, "/t", { out: "/o.mp4" }, { run: () => 1, copy: () => undefined }),
      /render failed/,
    );
    assert.deepEqual(renderArgs("/t", "/o.mp4", {}), [
      "scripts/render.mjs",
      "Scene",
      "--frames-dir",
      join("/t", "frames"),
      "--out",
      "/o.mp4",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("film preflight needs no kit and never prints an npx command", () => {
  assert.equal(preflight({ freeBytes: 9 * 1024 ** 3, ffmpeg: true }).length, 0);
  assert.equal(preflight({ freeBytes: 0, ffmpeg: false }).length, 2);
  assert.match(
    preflight({ kit: "/k", kitReady: false, freeBytes: 9 * 1024 ** 3, ffmpeg: true })[0],
    /npm install/,
  );
  assert.ok(!contactSheetArgs("f", "b.png").join(" ").includes("npx"));
  assert.ok(contactSheetArgs("f", "b.png").includes("b.png"));
});

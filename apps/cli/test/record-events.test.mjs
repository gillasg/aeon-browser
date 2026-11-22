// events.json: the writer must round-trip clip metadata and honest, clock-aligned actions.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clipScale,
  eventsFromTrace,
  soundCuesFromEvents,
  tabClips,
  writeEvents,
} from "../dist/record-events.js";

test("writeEvents writes an atomic, readable events.json", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aeon-events-"));
  try {
    const events = {
      version: 1,
      recorder: "aeon",
      clock: "clip",
      clip: {
        file: "clip.mp4",
        source: "window",
        width: 1280,
        height: 800,
        fps: 30,
        startedAt: 1000,
        durationMs: 2000,
        frames: 60,
      },
      events: [
        {
          id: "e1",
          kind: "click",
          t: 820,
          at: 1820,
          tabId: 4,
          page: { x: 12, y: 34 },
          window: { x: 62, y: 94 },
          text: "Go",
        },
      ],
    };
    const path = await writeEvents(folder, events);
    assert.equal(path, join(folder, "events.json"));
    const back = JSON.parse(await readFile(path, "utf8"));
    assert.equal(back.version, 1);
    assert.equal(back.clock, "clip");
    assert.equal(back.clip.fps, 30);
    assert.equal(back.clip.startedAt, 1000);
    assert.equal(back.events[0].kind, "click");
    assert.deepEqual(back.events[0].window, { x: 62, y: 94 });
    assert.equal(back.events[0].t, 820);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("eventsFromTrace puts each action on the clip clock with page and window positions", () => {
  const t0 = 1000;
  const trace = {
    chatId: "c1",
    trace: [
      {
        actions: [
          {
            kind: "click",
            tabId: 4,
            tStart: 1800,
            box: { x: 40, y: 60, width: 20, height: 10 },
            text: "Buy",
          },
          { kind: "input", tStart: 1500 }, // ignored: not an action kind
        ],
      },
      {
        actions: [
          { kind: "fill", tabId: 4, tStart: 2300, point: { x: 100, y: 200 }, text: "lamp" },
          { kind: "press", tStart: 2500, text: "Enter" },
          { kind: "navigate", tStart: 1100, url: "https://example.com" },
          { kind: "scroll", tStart: 2700, scroll: { x: 0, y: 300, direction: "down" } },
          { kind: "switchTab", tStart: 2900, tabId: 5, text: "Results" },
          { kind: "click", tStart: 3000, failed: true }, // failed actions are not logged
        ],
      },
    ],
  };
  const events = eventsFromTrace(trace, t0, { windowOffset: { x: 50, y: 70 }, scale: 2 });
  assert.deepEqual(
    events.map((e) => e.kind),
    ["navigate", "click", "type", "press", "scroll", "tab-switch"],
  );
  assert.equal(events[0].t, 100); // 1100 - 1000
  assert.equal(events[1].t, 800);
  assert.deepEqual(events[1].page, { x: 50, y: 65 });
  assert.deepEqual(events[1].window, { x: 150, y: 200 }); // offset + page * scale
  assert.equal(events[2].text, "lamp");
  assert.equal(events[3].text, "Enter");
  assert.equal(events[5].tabId, 5);
  assert.ok(events.every((e, i) => i === 0 || e.t >= events[i - 1].t));
});

test("a second tab opened mid-run is its own clip", () => {
  const t0 = 5_000;
  const trace = {
    trace: [
      {
        actions: [
          { kind: "navigate", tabId: 7, tStart: t0 + 100, url: "https://demo.test/" },
          { kind: "click", tabId: 7, tStart: t0 + 400, point: { x: 10, y: 10 }, text: "Open" },
        ],
      },
      {
        actions: [
          { kind: "openTab", tabId: 8, tStart: t0 + 700, url: "https://demo.test/next" },
          { kind: "click", tabId: 8, tStart: t0 + 900, point: { x: 20, y: 30 }, text: "Go" },
        ],
      },
    ],
  };
  const events = eventsFromTrace(trace, t0);
  const clips = tabClips(events, {
    file: "takes/",
    source: "tabs",
    width: 1280,
    height: 800,
    fps: 30,
    startedAt: t0,
    durationMs: 900,
    frames: 0,
  });
  assert.deepEqual(
    clips.map((clip) => clip.tabId),
    [7, 8],
  );
  assert.equal(clips[0].file, "takes/7.webm");
  assert.equal(clips[1].file, "takes/8.webm");
  assert.equal(clips[1].source, "tabs");
  assert.ok(events.some((event) => event.tabId === 8 && event.kind === "navigate"));
  assert.ok(events.some((event) => event.tabId === 8 && event.kind === "click"));
});

test("eventsFromTrace keeps element bounds in page and calibrated window space", () => {
  const trace = {
    trace: [
      {
        actions: [
          { kind: "click", tStart: 1500, box: { x: 40, y: 60, width: 20, height: 10 } },
          { kind: "fill", tStart: 1600, point: { x: 5, y: 6 }, text: "a" },
        ],
      },
    ],
  };
  const plain = eventsFromTrace(trace, 1000);
  assert.deepEqual(plain[0].box, { x: 40, y: 60, width: 20, height: 10 });
  assert.equal(plain[0].windowBox, undefined);
  assert.equal(plain[1].box, undefined);
  const calibrated = eventsFromTrace(trace, 1000, { windowOffset: { x: 0, y: 100 }, scale: 3 });
  assert.deepEqual(calibrated[0].windowBox, { x: 120, y: 280, width: 60, height: 30 });
  assert.deepEqual(calibrated[0].window, { x: 150, y: 295 });
});

test("clipScale records dpr and logical size only when known", () => {
  assert.deepEqual(clipScale({ width: 3840, height: 2160 }, 3), {
    dpr: 3,
    logicalWidth: 1280,
    logicalHeight: 720,
  });
  assert.deepEqual(clipScale({ width: 3840, height: 2160 }, undefined), {});
  assert.deepEqual(clipScale({ width: 0, height: 0 }, 2), {});
});

test("soundCuesFromEvents scores keys while typing and a trigger on click and Enter", () => {
  const cues = soundCuesFromEvents([
    { id: "e1", kind: "type", t: 100, at: 0, text: "abc" },
    { id: "e2", kind: "press", t: 400, at: 0, text: "Enter" },
    { id: "e3", kind: "press", t: 500, at: 0, text: "Tab" },
    { id: "e4", kind: "click", t: 600, at: 0 },
    { id: "e5", kind: "navigate", t: 700, at: 0, text: "https://example.com" },
  ]);
  assert.deepEqual(cues, [
    { t: 100, kind: "key" },
    { t: 155, kind: "key" },
    { t: 210, kind: "key" },
    { t: 400, kind: "trigger" },
    { t: 600, kind: "trigger" },
  ]);
});

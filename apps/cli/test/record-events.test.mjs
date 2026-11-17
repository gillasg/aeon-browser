// events.json: the writer must round-trip clip metadata and honest, clock-aligned actions.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { eventsFromTrace, writeEvents } from "../dist/record-events.js";

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

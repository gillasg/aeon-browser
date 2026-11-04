import assert from "node:assert/strict";
import test from "node:test";
import { speedLine, speedReport } from "../dist/speed.js";
import { summarize } from "../dist/results.js";

// The speed report splits the latest run's wall time into model turns and tool time from the
// entries' own timestamps, so the parts always add up to the run, and it counts what the cells
// reported (sleeps cut, speed tips).
const at = (seconds) => new Date(Date.UTC(2026, 10, 4, 10, 0, seconds)).toISOString();
const entry = (seconds, message) => ({ timestamp: at(seconds), message });
const call = (seconds, id) =>
  entry(seconds, {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "browser_code", arguments: {} }],
  });
const result = (seconds, id, text) =>
  entry(seconds, {
    role: "tool",
    toolCallId: id,
    toolName: "browser_code",
    content: [{ type: "text", text }],
  });

const entries = [
  entry(0, { role: "user", content: [{ type: "text", text: "earlier task" }] }),
  call(50, "old"),
  result(90, "old", "old work"),
  entry(100, { role: "user", content: [{ type: "text", text: "compare prices" }] }),
  call(104, "a"),
  result(124, "a", "[sleep] 3 waits ended 6.5 s early, when the page settled"),
  call(130, "b"),
  result(140, "b", "Tip: a.test and b.test were worked one after another (4 cells, 30 s"),
  entry(145, { role: "assistant", content: [{ type: "text", text: "Done." }] }),
];

test("the latest run's time splits into model turns and tools, adding up to the run", () => {
  const report = speedReport(entries);
  assert.deepEqual(report, {
    turns: 3,
    modelSeconds: 15,
    toolSeconds: { browser_code: 30 },
    sleepsCutSeconds: 6.5,
    tips: ["serial"],
  });
  assert.equal(
    speedLine(report),
    "Time: model 15 s over 3 turns (5 s each) · browser_code 30 s · sleeps cut 7 s · tips: serial",
  );
});

test("the chat result carries the report and each step's seconds", () => {
  const summary = summarize(
    "c",
    "compare prices",
    { chat: { chatId: "c", title: "t" }, runState: "idle", contextUsage: null, entries },
    45_000,
    "finished",
  );
  assert.equal(summary.speed.turns, 3);
  assert.deepEqual(
    summary.trace.map((step) => step.seconds),
    [40, 20, 10],
  );
});

test("no user message or no model turn means no report", () => {
  assert.equal(speedReport([]), undefined);
  assert.equal(speedReport([entries[3]]), undefined);
  assert.equal(speedLine(undefined), "");
});

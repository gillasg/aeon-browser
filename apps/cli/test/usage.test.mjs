import assert from "node:assert/strict";
import test from "node:test";
import { summarize, usageTotals } from "../dist/results.js";

// A run's result carries the tokens and estimated cost summed over its model turns, so eval
// harnesses can report cost per task without reading Pi's session files.
const turn = (input, cacheRead, output, cost) => ({
  timestamp: "2026-11-04T10:00:00.000Z",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    usage: { input, output, cacheRead, cacheWrite: 0, cost: { total: cost } },
  },
});

test("usage totals add every turn's tokens and cost", () => {
  const totals = usageTotals([turn(1000, 0, 50, 0.001), turn(100, 9000, 20, 0.0002)]);
  assert.deepEqual(totals, {
    turns: 2,
    input: 1100,
    output: 70,
    cacheRead: 9000,
    cacheWrite: 0,
    cost: 0.0012,
  });
});

test("a chat with no reported usage has no usage field", () => {
  const user = { timestamp: "2026-11-04T10:00:00.000Z", message: { role: "user", content: [] } };
  const result = summarize(
    "c1",
    "hi",
    { chat: { chatId: "c1", title: "" }, runState: "idle", contextUsage: null, entries: [user] },
    0,
    "finished",
  );
  assert.equal(result.usage, undefined);
});

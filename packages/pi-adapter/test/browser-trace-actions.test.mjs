import assert from "node:assert/strict";
import test from "node:test";
import { storedTraceActions, traceActions } from "../dist/browser-trace-actions.js";

// The trace a chat keeps (and `aeon trace --json` prints) carries each input step's closed
// effect and its evidence, so an eval row can tell a suspected no-op from a confirmed change.

test("an input step's effect and evidence reach its trace row", () => {
  const [action] = traceActions([
    {
      action: { op: "click", target: { tabId: 41 } },
      disposition: "completed",
      tStart: 100,
      tEnd: 180,
      result: {
        kind: "action",
        outcome: "unchanged",
        effect: "suspected_noop",
        evidence: "no navigation, DOM change or request after click",
      },
    },
  ]);
  assert.equal(action.kind, "click");
  assert.equal(action.effect, "suspected_noop");
  assert.equal(action.evidence, "no navigation, DOM change or request after click");
});

test("a refused step's own effect reaches its row, and a read has none", () => {
  const [refused] = traceActions([
    {
      action: { op: "fill", target: { tabId: 41 } },
      disposition: "failed",
      code: "TARGET_DISABLED",
      effect: "refused",
      evidence: "TARGET_DISABLED",
      tStart: 100,
      tEnd: 120,
    },
  ]);
  assert.equal(refused.failed, true);
  assert.equal(refused.effect, "refused");
  assert.equal(refused.evidence, "TARGET_DISABLED");
  const [read] = traceActions([
    { action: { op: "observe" }, disposition: "completed", tStart: 1, tEnd: 2 },
  ]);
  assert.equal(read.effect, undefined);
});

test("stored trace actions keep the fields they were saved with", () => {
  const [action] = storedTraceActions({
    actions: [
      {
        kind: "click",
        tStart: 100,
        tEnd: 180,
        effect: "confirmed",
        evidence: "navigation to https://b.test/",
      },
    ],
  });
  assert.equal(action.effect, "confirmed");
  assert.equal(action.evidence, "navigation to https://b.test/");
});

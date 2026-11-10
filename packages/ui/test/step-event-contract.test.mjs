import assert from "node:assert/strict";
import test from "node:test";
import { actionLine } from "@aeon/protocol";
import { applyEvent, cursorSteps, initialRun } from "../dist/run-model.js";

// The model line, the timeline and the ledger all read these strings. labelFor (engine) produces
// the label; this locks the three readers to it.
const place = {
  id: "c:0",
  cellId: "cell",
  chatId: "chat",
  tabId: 7,
  at: 100,
  ms: 20,
  kind: "click",
  label: "Click “Place order”",
  site: "shop.test",
  effect: "confirmed",
  evidence: { request: { method: "POST", path: "/api/profile", status: 200 } },
  write: true,
  box: { x: 10, y: 20, width: 4, height: 6 },
};
const read = {
  ...place,
  id: "c:1",
  at: 400,
  kind: "read",
  label: "Read “Order”",
  effect: "confirmed",
  write: false,
  evidence: { valueRead: true },
};

const start = {
  kind: "tool-start",
  toolCallId: "call-1",
  toolName: "browser_code",
  arguments: { code: "await page.click('#pay')" },
};

function update(steps) {
  return {
    kind: "tool-update",
    toolCallId: "call-1",
    toolName: "browser_code",
    arguments: { code: "await page.click('#pay')" },
    partialResult: "",
    steps,
  };
}

test("the model line, the timeline and the ledger use the same step labels", () => {
  assert.equal(actionLine(place), "Click “Place order” → confirmed (POST /api/profile 200)");
  assert.equal(actionLine(read), "Read “Order” → confirmed (value read back)");
  let run = applyEvent(initialRun(), start, 0);
  run = applyEvent(run, update([place]), 1);
  assert.equal(run.steps[0].label, place.label);
  assert.deepEqual(run.steps[0].liveLabels, [place.label]);
  assert.deepEqual(cursorSteps(run.actions, 7), [{ kind: "click", x: 12, y: 23, delayMs: 0 }]);
  run = applyEvent(run, update([place, read]), 2);
  assert.equal(run.steps[0].label, read.label);
  assert.deepEqual(run.steps[0].liveLabels, [place.label, read.label]);
  assert.deepEqual(
    [place, read].filter((event) => event.write).map((event) => event.label),
    [place.label],
  );
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { executeBrowserBatch } from "../dist/browser-batch.js";

const target = {
  clientInstanceId: randomUUID(),
  browserRunId: randomUUID(),
  tabId: 7,
  tabIncarnation: randomUUID(),
};
const click = {
  op: "click",
  target,
  element: { kind: "backend", backendNodeId: 1, documentEpoch: 1 },
  observe: false,
};
const detail =
  "TIMEOUT: the step took too long\nHint: check the page with bu.state() before retrying once\nNext: await bu.state()";

test("a sent write that times out reports an unknown effect and no retry hint", async () => {
  const text = await executeBrowserBatch(
    { steps: [click, { op: "listTabs" }] },
    "tc",
    async () => ({
      code: "TIMEOUT",
      detail,
    }),
  );
  const result = JSON.parse(text);
  assert.equal(result.steps[0].disposition, "failed");
  assert.equal(result.steps[0].effect, "unverifiable");
  assert.match(result.steps[0].detail, /may have landed/);
  assert.doesNotMatch(result.steps[0].detail, /^Next:/m);
  assert.equal(result.steps[1].disposition, "skipped", "the batch still stops at the failure");
});

test("a read failure is not given an unknown-input effect", async () => {
  const text = await executeBrowserBatch({ steps: [{ op: "listTabs" }] }, "tc", async () => ({
    code: "TIMEOUT",
    detail,
  }));
  const step = JSON.parse(text).steps[0];
  assert.equal(step.effect, undefined);
  assert.match(step.detail, /Next: await bu\.state\(\)/);
});

test("a write refused before it was sent keeps its refusal detail", async () => {
  const text = await executeBrowserBatch({ steps: [click] }, "tc", async () => ({
    code: "TARGET_DISABLED",
    detail: "TARGET_DISABLED: the control is disabled\nNext: await bu.state()",
  }));
  const step = JSON.parse(text).steps[0];
  assert.equal(step.effect, undefined);
  assert.match(step.detail, /Next: await bu\.state\(\)/);
});

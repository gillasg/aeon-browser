import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BrowserStepSchema, BrowserExecutorResultSchema } from "../dist/index.js";
const target = {
  clientInstanceId: randomUUID(),
  browserRunId: randomUUID(),
  tabId: 1,
  tabIncarnation: randomUUID(),
};
test("persistent runtime commands and document-bound backend ids cross the protocol", () => {
  for (const step of [
    { op: "evaluate", target, expression: "document.title" },
    { op: "cdp", target, method: "Runtime.evaluate", params: { expression: "42" } },
    { op: "waitFor", target, expression: "!!document.body" },
    {
      op: "click",
      target,
      element: { kind: "backend", backendNodeId: 123, documentEpoch: 1 },
      observe: false,
    },
  ])
    assert.equal(BrowserStepSchema.parse(step).op, step.op);
  assert.equal(
    BrowserStepSchema.safeParse({ op: "cdp", target, method: "Invalid command" }).success,
    false,
  );
  assert.equal(
    BrowserStepSchema.safeParse({
      op: "click",
      target,
      element: { kind: "backend", backendNodeId: 123 },
    }).success,
    false,
  );
  const state = BrowserExecutorResultSchema.parse({
    kind: "semantic",
    source: "website",
    trust: "untrusted",
    target,
    url: "https://example.test",
    documentEpoch: 1,
    snapshotId: randomUUID(),
    nodes: [
      {
        ref: "e0",
        backendNodeId: 123,
        role: "tab",
        name: "Settings",
        expanded: false,
        selected: true,
        pressed: "mixed",
        mixed: true,
      },
    ],
    text: "Visible content",
    truncated: false,
  });
  assert.equal(state.nodes[0].selected, true);
});

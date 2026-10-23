import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BrowserStepSchema, BrowserOperationResultSchema } from "../dist/index.js";
const target = {
  clientInstanceId: randomUUID(),
  browserRunId: randomUUID(),
  tabId: 1,
  tabIncarnation: randomUUID(),
};
test("locator variants, focused snapshots and keyboard actions pass strict validation", () => {
  for (const by of ["css", "label", "text", "placeholder"])
    assert.equal(
      BrowserStepSchema.parse({
        op: "fill",
        target,
        element: { kind: "query", by, value: "Search" },
        value: "test",
      }).op,
      "fill",
    );
  assert.equal(
    BrowserStepSchema.parse({
      op: "press",
      target,
      element: { kind: "locator", role: "combobox", name: "" },
      key: "Enter",
    }).key,
    "Enter",
  );
  assert.equal(
    BrowserStepSchema.parse({
      op: "observe",
      target,
      kind: "semantic",
      query: "Ask",
      selector: "#main",
      interactive: true,
    }).query,
    "Ask",
  );
  assert.equal(
    BrowserStepSchema.parse({ op: "wait", target, selector: "#ready" }).state,
    "visible",
  );
  assert.equal(
    BrowserStepSchema.safeParse({
      op: "press",
      target,
      element: { kind: "query", by: "css", value: "input" },
      key: "anything",
    }).success,
    false,
  );
});
test("actionability errors retain bounded guidance", () => {
  for (const code of [
    "TARGET_NOT_FOUND",
    "TARGET_HIDDEN",
    "TARGET_BLOCKED",
    "TARGET_DISABLED",
    "NOT_EDITABLE",
    "INPUT_FAILED",
  ])
    assert.equal(
      BrowserOperationResultSchema.parse({
        kind: "browser.operation.result",
        requestId: randomUUID(),
        operationId: randomUUID(),
        ok: false,
        code,
        detail: "Inspect the visible input",
      }).detail,
      "Inspect the visible input",
    );
});

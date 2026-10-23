import test from "node:test";
import assert from "node:assert/strict";
import { resultText } from "../dist/pi-content-projection.js";

test("a browser result with many steps never passes the protocol's text limit", () => {
  // page.list() scrolls a screen per step, so one cell can record hundreds of steps.
  const steps = Array.from({ length: 600 }, (_, index) => ({
    index,
    disposition: "completed",
    code: "evaluate",
    action: { op: "evaluate", target: { tabId: 1, url: "https://example.com/jobs?page=" + index } },
    result: { kind: "value", value: "x".repeat(200) },
  }));
  const text = JSON.stringify({ operationId: "op", toolCallId: "call", steps });
  const bounded = resultText(text);
  assert.ok(bounded.length <= 24_020, `got ${bounded.length} characters`);
  assert.ok(resultText({ content: [{ type: "text", text }] }).length <= 24_020);
});

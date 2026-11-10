import assert from "node:assert/strict";
import test from "node:test";
import { actionLine } from "@aeon/protocol";
import { formatStepLine } from "../dist/browser-code-tool.js";

const event = {
  id: "c:0",
  cellId: "11111111-1111-4111-8111-111111111111",
  chatId: "22222222-2222-4222-8222-222222222222",
  tabId: 7,
  at: 100,
  ms: 20,
  kind: "click",
  label: "Click “Place order”",
  site: "shop.test",
  effect: "confirmed",
  evidence: { request: { method: "POST", path: "/api/profile", status: 200 } },
  write: true,
};

test("the model action line is the step event's label, effect and evidence", () => {
  const line = formatStepLine({
    action: { op: "click" },
    event,
    result: { next: "page.snapshot()" },
  });
  assert.equal(line, "- " + actionLine(event) + "\n  Next: page.snapshot()");
  assert.match(line, /Click “Place order” → confirmed \(POST \/api\/profile 200\)/);
});

test("a folded repeat is not a second model line", () => {
  assert.equal(formatStepLine({ loopFolded: true, action: { op: "click" }, event }), "");
});

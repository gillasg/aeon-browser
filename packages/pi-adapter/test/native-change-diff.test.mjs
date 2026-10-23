import assert from "node:assert/strict";
import test from "node:test";
import { projectMessage } from "../dist/pi-message-projection.js";
import { projectChangeDiff } from "../dist/pi-change-diff.js";

test("native edit diffs retain Pi's actual source line numbers", () => {
  const diff = "  41 unchanged\n- 42 old value\n+ 42 new value";
  const message = projectMessage({
    role: "toolResult",
    toolCallId: "edit-1",
    toolName: "edit",
    isError: false,
    content: [{ type: "text", text: "Successfully replaced text." }],
    details: { diff },
  });
  assert.equal(message.changeDiff, diff);
});

test("failed or oversized edits never claim a confirmed partial diff", () => {
  assert.equal(projectChangeDiff({ details: { diff: "x".repeat(24_001) } }), undefined);
  assert.equal(projectChangeDiff({ details: { diff: 12 } }), undefined);
  assert.equal(projectChangeDiff(null), undefined);
  const message = projectMessage({
    role: "toolResult",
    toolCallId: "edit-2",
    toolName: "edit",
    isError: true,
    content: [{ type: "text", text: "Text not found." }],
    details: { diff: "+ 42 value" },
  });
  assert.equal(message.changeDiff, undefined);
});

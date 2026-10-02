import assert from "node:assert/strict";
import test from "node:test";
import { TranscriptModel } from "../dist/transcript-model.js";

test("live Pi tool message-end preserves image metadata before a persisted-entry notification", () => {
  const model = new TranscriptModel();
  model.apply({
    kind: "tool-start",
    toolCallId: "capture-1",
    toolName: "browser_control",
    arguments: { steps: [{ op: "observe", kind: "screenshot" }] },
  });
  const message = {
    role: "tool",
    toolCallId: "capture-1",
    toolName: "browser_control",
    isError: false,
    content: [
      { type: "text", text: "Captured screenshot" },
      { type: "image", mimeType: "image/png", byteLength: 10 },
    ],
  };
  model.apply({ kind: "message-end", message });
  model.apply({
    kind: "tool-end",
    toolCallId: "capture-1",
    toolName: "browser_control",
    result: "Captured screenshot",
    isError: false,
  });
  const group = model.rows.find((row) => row.kind === "tool-group");
  assert.deepEqual(group.group.steps[0].images, [{ mimeType: "image/png", byteLength: 10 }]);
  assert.equal(group.group.steps[0].state, "complete");
  assert.equal(
    model.rows.some((row) => row.kind === "transient" && row.message.role === "tool"),
    false,
  );
  model.apply({
    kind: "entry-added",
    entry: {
      entryId: "entry-1",
      parentEntryId: null,
      timestamp: new Date().toISOString(),
      category: "message",
      message,
    },
  });
  assert.equal(group.group.steps.length, 1);
  assert.equal(group.group.steps[0].images.length, 1);
});

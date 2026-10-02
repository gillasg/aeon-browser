import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptModel } from "../dist/transcript-model.js";
import { TranscriptTurn } from "../dist/transcript-turn.js";
test("partial answer after a tool is outside the work disclosure before message-end", () => {
  const model = new TranscriptModel();
  model.apply({
    kind: "entry-added",
    entry: {
      entryId: "u",
      parentEntryId: null,
      timestamp: new Date().toISOString(),
      category: "message",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    },
  });
  model.apply({ kind: "tool-start", toolCallId: "t", toolName: "write", arguments: { path: "x" } });
  model.apply({
    kind: "tool-end",
    toolCallId: "t",
    toolName: "write",
    result: "done",
    isError: false,
  });
  for (const text of ["First", "First second"]) {
    model.apply({
      kind: "message-update",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: "Reasoning increment" },
          { type: "text", text },
        ],
        stopReason: "pending",
      },
    });
    const html = renderToStaticMarkup(
      createElement(TranscriptTurn, { rows: [...model.rows], actions: { actionsDisabled: true } }),
    );
    assert.ok(html.lastIndexOf(text) > html.lastIndexOf("</details>"));
    assert.match(html, /Reasoning increment/);
  }
});

test("each streamed update publishes a new row array and partial tool arguments", () => {
  const model = new TranscriptModel();
  const initial = model.rows;
  model.apply({
    kind: "message-update",
    message: {
      role: "assistant",
      stopReason: "pending",
      content: [
        { type: "tool-call", toolCallId: "t", toolName: "write", arguments: { path: "test.txt" } },
      ],
    },
  });
  assert.notEqual(model.rows, initial);
  assert.equal(model.rows[0].group.steps[0].state, "pending");
  const before = model.rows;
  model.apply({
    kind: "tool-update",
    toolCallId: "t",
    toolName: "write",
    arguments: { path: "test.txt" },
    partialResult: "first chunk",
  });
  assert.notEqual(model.rows, before);
  assert.equal(model.rows[0].group.steps[0].partialResult, "first chunk");
});

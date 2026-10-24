import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { WebSocket } from "ws";
import { BrowserCodeCells } from "../dist/browser-code-cells.js";

function socket(messages) {
  return {
    readyState: WebSocket.OPEN,
    send(value) {
      messages.push(JSON.parse(String(value)));
    },
    once() {},
    off() {},
  };
}

test("a browser code deadline stops only the cell, not its variables or tabs", async () => {
  const messages = [];
  const cells = new BrowserCodeCells(() => undefined);
  await assert.rejects(
    () =>
      cells.run(socket(messages), randomUUID(), "call-1", [], {
        code: "while (true) {}",
        timeoutMs: 1000,
        onCall: async () => ({}),
        onProgress: () => undefined,
      }),
    /variables and tabs are still there/,
  );
  const cancel = messages.find((message) => message.kind === "browser.code.cancel");
  assert.ok(cancel, JSON.stringify(messages));
  assert.equal(cancel.reset, false);
});

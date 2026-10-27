import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
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

function eventSocket(messages) {
  const socket = new EventEmitter();
  socket.readyState = WebSocket.OPEN;
  socket.sent = messages;
  socket.send = (value) => messages.push(JSON.parse(String(value)));
  return socket;
}

test("a browser code deadline stops only the cell, not its variables or tabs", async () => {
  const messages = [];
  const cells = new BrowserCodeCells(() => undefined);
  await assert.rejects(
    () =>
      cells.run(socket(messages), randomUUID(), randomUUID(), "call-1", [], {
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

test("a short link drop keeps the cell and it answers on the new socket", async () => {
  const first = [];
  const second = [];
  const cells = new BrowserCodeCells(() => undefined);
  const oldSocket = eventSocket(first);
  const clientInstanceId = randomUUID();
  const running = cells.run(oldSocket, clientInstanceId, randomUUID(), "call-1", [], {
    code: "1 + 1",
    timeoutMs: 5000,
    onCall: async () => ({}),
    onProgress: () => undefined,
  });
  const cellId = first[0].cellId;
  oldSocket.emit("close");
  const newSocket = eventSocket(second);
  cells.rebind(clientInstanceId, newSocket);
  cells.handle(
    { kind: "browser.code.result", cellId, output: "", steps: [], opened: [], value: 2 },
    newSocket,
  );
  const result = await running;
  assert.equal(result.value, 2);
});

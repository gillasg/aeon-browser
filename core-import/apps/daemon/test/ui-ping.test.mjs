import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { attachDevChatCommands } from "../dist/dev-chat-connection.js";

test("a UI ping is answered with a pong and never closes the connection", () => {
  const socket = new EventEmitter();
  const sent = [];
  let closed;
  socket.send = (data) => sent.push(JSON.parse(data));
  socket.close = (code, reason) => (closed = { code, reason });
  attachDevChatCommands(socket, {}, () => false);
  const requestId = "0c3b1e36-6bb3-4d55-8f6f-6b1f1a0b8f11";
  socket.emit("message", Buffer.from(JSON.stringify({ kind: "ping", requestId })), false);
  assert.deepEqual(sent, [{ kind: "pong", requestId }]);
  assert.equal(closed, undefined);
});

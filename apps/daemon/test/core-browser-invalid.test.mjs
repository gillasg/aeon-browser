// A run request the schema refuses is answered, never dropped: the client would wait forever.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CoreBrowserRunRequestSchema } from "@aeon/protocol";
import { WebSocket } from "ws";
import { handleBrowserRun } from "../dist/core-browser.js";

function socket() {
  const sent = [];
  return { sent, readyState: WebSocket.OPEN, send: (text) => sent.push(JSON.parse(text)) };
}

const run = (fields) => ({
  kind: "core.browser.run",
  requestId: randomUUID(),
  session: "s",
  ...fields,
});

test("a cell over the timeout limit gets INVALID_INPUT naming the field", () => {
  const ws = socket();
  const request = run({ code: "1", timeoutMs: 900_000 });
  assert.equal(handleBrowserRun(ws, request, {}, "/tmp"), true);
  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0].requestId, request.requestId);
  assert.equal(ws.sent[0].error, "INVALID_INPUT");
  assert.match(ws.sent[0].detail, /timeoutMs/);
});

test("a 20k-character cell is accepted; an unrelated message is left to other routes", () => {
  assert.equal(
    CoreBrowserRunRequestSchema.safeParse(run({ code: "x".repeat(20_000) })).success,
    true,
  );
  const ws = socket();
  assert.equal(handleBrowserRun(ws, { kind: "core.ping" }, {}, "/tmp"), false);
  assert.equal(handleBrowserRun(ws, run({ code: "x".repeat(70_000) }), {}, "/tmp"), true);
  assert.match(ws.sent[0].detail, /code/);
});

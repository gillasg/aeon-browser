// A `graft repl` cell runs only while its client is connected: when the CLI is cancelled and its
// socket closes mid-cell, the cell is aborted and the session is released with its tabs tidied.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { handleBrowserRun } from "../dist/core-browser.js";

function socket() {
  const ws = new EventEmitter();
  ws.sent = [];
  ws.readyState = WebSocket.OPEN;
  ws.send = (text) => ws.sent.push(JSON.parse(text));
  return ws;
}

function fakeBrowser() {
  const calls = [];
  return {
    calls,
    execute(chatId, id, raw, signal) {
      calls.push({ chatId, raw, signal });
      if (!raw.codeCell) return Promise.resolve("{}");
      return new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(JSON.stringify({ error: "CANCELLED" }))),
      );
    },
  };
}

const run = () => ({
  kind: "core.browser.run",
  requestId: randomUUID(),
  session: "s",
  code: "await new Promise(() => {})",
});

test("closing the client mid-cell aborts the cell and tidies the session's tabs", async () => {
  const ws = socket();
  const browser = fakeBrowser();
  assert.equal(handleBrowserRun(ws, run(), browser, "/tmp"), true);
  await new Promise((done) => setTimeout(done, 0));
  const cell = browser.calls[0];
  assert.equal(cell.signal.aborted, false);
  ws.readyState = WebSocket.CLOSED;
  ws.emit("close");
  assert.equal(cell.signal.aborted, true, "the in-flight cell is aborted at once");
  const release = browser.calls.find((call) => call.raw.release);
  assert.deepEqual(release.raw, { release: true, reset: true, tidy: true });
  assert.equal(release.chatId, cell.chatId);
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(ws.sent.length, 0, "nothing is sent to a closed socket");
});

test("a finished cell leaves nothing to clean up when the client later closes", async () => {
  const ws = socket();
  const browser = fakeBrowser();
  browser.execute = (chatId, id, raw, signal) => {
    browser.calls.push({ chatId, raw, signal });
    return Promise.resolve(JSON.stringify({ value: 2 }));
  };
  handleBrowserRun(ws, run(), browser, "/tmp");
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(ws.sent[0].value, 2);
  ws.emit("close");
  assert.equal(browser.calls.filter((call) => call.raw.release).length, 0);
});

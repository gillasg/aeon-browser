// Real Chrome: a drag on a draggable=true sortable list goes through drag interception and the
// replayed drop really reorders it; the engine's dispatchPointer runs over a CDP socket shim.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const chromePath = process.env.CHROME_PATH ?? "";

const PAGE = `<!doctype html><body><ul id="list" style="list-style:none;margin:0;padding:0">
<li draggable="true" style="height:40px">A</li><li draggable="true" style="height:40px">B</li><li draggable="true" style="height:40px">C</li></ul>
<script>
var dragged = null, list = document.getElementById('list');
list.addEventListener('dragstart', (e) => { dragged = e.target; e.dataTransfer.setData('text/plain', e.target.textContent); });
list.addEventListener('dragover', (e) => e.preventDefault());
list.addEventListener('drop', (e) => { e.preventDefault(); var to = e.target.closest('li'); if (dragged && to && to !== dragged) list.insertBefore(dragged, to.nextSibling); });
</script>`;

async function cdp(url) {
  const socket = new WebSocket(url);
  await new Promise((done, fail) => (socket.once("open", done), socket.once("error", fail)));
  let id = 0;
  const waiting = new Map();
  const listeners = new Set();
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.method)
      for (const fn of listeners) fn({ tabId: 1 }, message.method, message.params);
    else {
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((done, fail) => {
      waiting.set(++id, (m) => (m.error ? fail(new Error(m.error.message)) : done(m.result)));
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { send, listeners, close: () => socket.close() };
}

test(
  "an HTML5 sortable list reorders through an intercepted drag",
  { skip: !process.env.REQUIRE_E2E && !(chromePath && existsSync(chromePath)) },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "aeon-html5-drag-"));
    const chrome = spawn(
      chromePath,
      [
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        "--headless=new",
        "--no-first-run",
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    try {
      const endpoint = await new Promise((done) => {
        let text = "";
        chrome.stderr.on("data", (chunk) => {
          text += chunk;
          const found = /ws:\/\/\S+/.exec(text);
          if (found) done(found[0]);
        });
      });
      const port = new URL(endpoint).port;
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = await cdp(targets.find((item) => item.type === "page").webSocketDebuggerUrl);
      globalThis.chrome = {
        debugger: {
          sendCommand: (_debuggee, method, params) => page.send(method, params),
          onEvent: {
            addListener: (fn) => page.listeners.add(fn),
            removeListener: (fn) => page.listeners.delete(fn),
          },
        },
      };
      const { dispatchPointer } = await import("../dist/native-browser-pointer.js");
      await page.send("Page.enable");
      await page.send("Page.navigate", { url: "data:text/html," + encodeURIComponent(PAGE) });
      await new Promise((done) => setTimeout(done, 500));
      const result = await dispatchPointer(
        { tabId: 1 },
        { op: "pointer", action: "drag", x: 20, y: 20, toX: 20, toY: 100 },
      );
      assert.equal(result.html5, true, JSON.stringify(result));
      assert.equal(result.dragged, true);
      const order = await page.send("Runtime.evaluate", {
        expression: "[...document.querySelectorAll('li')].map((li) => li.textContent).join('')",
        returnByValue: true,
      });
      assert.equal(order.result.value, "BCA");
      page.close();
    } finally {
      delete globalThis.chrome;
      chrome.kill();
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  },
);

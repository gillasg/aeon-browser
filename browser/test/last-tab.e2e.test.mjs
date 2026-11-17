// Real Chrome: closing the last tab, and Page.close, must not quit the browser.
// Run alone, from browser/: node --test test/last-tab.e2e.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const chromePath =
  process.env.CHROME_PATH ??
  resolve("../.slice0-audit/chrome-for-testing-157.0.8103.78/chrome-win64/chrome.exe");
const extension = resolve("apps/extension/build");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const probe = `(() => {
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  const describe = (tab) => ({ url: tab.url || "", pending: tab.pendingUrl || "" });
  const run = async () => {
    let before = await chrome.tabs.query({});
    let signature = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const next = before.map((tab) => tab.id + (tab.pendingUrl || tab.url || "")).join("|");
      if (next === signature && before.length > 0) break;
      signature = next;
      await pause(100);
      before = await chrome.tabs.query({});
    }
    const ids = before.map((tab) => tab.id).filter((id) => id !== undefined);
    await chrome.tabs.remove(ids);
    const after = await chrome.tabs.query({});
    const survivor = after.find((tab) => !ids.includes(tab.id)) || after[0];
    let pageClose = "missing";
    if (survivor && survivor.id !== undefined) {
      await chrome.debugger.attach({ tabId: survivor.id }, "1.3");
      await chrome.debugger.sendCommand({ tabId: survivor.id }, "Page.close");
      pageClose = "ok";
    }
    const left = await chrome.tabs.query({});
    return {
      before: ids.length,
      removed: ids,
      after: after.map((tab) => tab.id),
      pageClose,
      left: left.map(describe),
    };
  };
  return run();
})()`;

test(
  "closing the last tab and Page.close leave Chrome open on a blank tab",
  {
    skip:
      !process.env.REQUIRE_E2E && (!existsSync(chromePath) || !existsSync(extension))
        ? "Chrome for Testing or the built extension is missing"
        : false,
  },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "bue-last-tab-"));
    const chrome = spawn(chromePath, chromeArgs(profile), { stdio: "ignore" });
    try {
      const port = await waitFor(async () =>
        Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]),
      );
      const worker = await waitFor(async () => {
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
          response.json(),
        );
        const found = targets.find((item) => item.url.endsWith("/service-worker.js"));
        if (!found) throw new Error("no worker yet");
        return found;
      });
      const cdp = await connect(worker.webSocketDebuggerUrl);
      await waitFor(async () => {
        const ready = await cdp("Runtime.evaluate", {
          expression: "typeof chrome?.tabs?.query",
          returnByValue: true,
        });
        if (ready.result?.result?.value !== "function") throw new Error("tabs API not ready");
      });
      const evaluated = await cdp("Runtime.evaluate", {
        expression: probe,
        awaitPromise: true,
        returnByValue: true,
      });
      const value = evaluated.result?.result?.value;
      assert.equal(chrome.exitCode, null);
      assert.equal(evaluated.result?.exceptionDetails, undefined, JSON.stringify(evaluated));
      assert.ok(value.before >= 1, JSON.stringify(value));
      assert.ok(value.left.length >= 1, JSON.stringify(value));
      assert.equal(value.pageClose, "ok", JSON.stringify(value));
      assert.ok(
        value.left.some((tab) => tab.url === "about:blank" || tab.pending === "about:blank"),
        JSON.stringify(value),
      );
      for (const id of value.removed) assert.ok(!value.after.includes(id), JSON.stringify(value));
      const still = await fetch(`http://127.0.0.1:${port}/json/version`);
      assert.equal(still.ok, true);
    } finally {
      chrome.kill();
      await sleep(300);
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
    }
  },
  90000,
);

function chromeArgs(profile) {
  return [
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    `--load-extension=${extension}`,
    `--disable-extensions-except=${extension}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--headless=new",
    ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
    "about:blank",
  ];
}

async function waitFor(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      last = error;
      await sleep(100);
    }
  }
  throw last ?? new Error("timed out");
}

function connect(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  const opened = new Promise((done) => socket.once("open", done));
  return async (method, params = {}) => {
    await opened;
    const callId = ++id;
    socket.send(JSON.stringify({ id: callId, method, params }));
    return new Promise((done) => waiting.set(callId, done));
  };
}

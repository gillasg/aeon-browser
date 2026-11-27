/* eslint-disable max-lines-per-function -- one end-to-end scenario with a replaceable fake Core */
// Real Chrome proof: after the daemon/host link drops and the daemon restarts on a new endpoint,
// the extension reconnects on its own (via the wake alarm) without restarting Chrome.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { chromeForTestingPath } from "./browser-fixture-helper.mjs";

const chromePath = chromeForTestingPath();
const extension = resolve("apps/chrome-extension/native-dist");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const debug = process.env.GRAFT_TEST_DEBUG
  ? (...parts) => process.stderr.write("RECONNECT " + parts.join(" ") + "\n")
  : () => {};

test(
  "the extension reconnects after a daemon restart without a Chrome restart",
  {
    skip:
      existsSync(chromePath) && existsSync(extension)
        ? false
        : "Chrome for Testing or the built extension is missing",
    timeout: 120_000,
  },
  async () => {
    const cores = [];
    const profile = await mkdtemp(join(tmpdir(), "graft-reconnect-e2e-"));
    const chrome = spawn(
      chromePath,
      [
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        `--load-extension=${extension}`,
        `--disable-extensions-except=${extension}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--headless=new",
        ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    try {
      const port = await debugPort(profile);
      const worker = await waitForTarget(port, (item) => item.url.endsWith("/service-worker.js"));
      const cdp = await connect(worker.webSocketDebuggerUrl);
      for (let i = 0; i < 100; i++) {
        const ready = await cdp("Runtime.evaluate", {
          expression: "typeof chrome?.runtime?.id",
          returnByValue: true,
        });
        if (ready.result?.result?.value === "string") break;
        await sleep(100);
      }
      debug("worker ready");
      // Same bootstrap override the other extension e2es use: one literal endpoint per daemon.
      const override = (
        core,
      ) => `chrome.runtime.sendNativeMessage = (_host, request, callback) => callback({
        kind: "native.bootstrap.result", protocolVersion: request.protocolVersion, ok: true,
        endpoint: "ws://127.0.0.1:${core.port}/graft/v1", connectionGrant: "${"A".repeat(43)}",
        expiresAt: Date.now() + 600000, daemonProtocolVersion: request.protocolVersion });`;

      const first = await fakeCore();
      cores.push(first);
      await cdp("Runtime.evaluate", { expression: override(first) });
      const browserCdp = await connect(
        (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()))
          .webSocketDebuggerUrl,
      );
      await browserCdp("Target.createTarget", { url: "about:blank" });
      await withTimeout(first.connected, 20_000, "first connection");
      debug("first daemon connected");

      // A daemon restart drops the executor link and moves the endpoint to a new port.
      first.drop();
      await first.close();
      const second = await fakeCore();
      cores.push(second);
      await cdp("Runtime.evaluate", { expression: override(second) });
      debug("endpoint moved to", second.port);
      // Fire the reconnect alarm: Chrome wakes a sleeping worker to run the listener. No Chrome
      // restart, no new tab, no manual nudge — this is the path the fix relies on.
      await cdp("Runtime.evaluate", {
        expression:
          "chrome.alarms.create('graft-executor-reconnect-now', { when: Date.now() + 50 })",
        awaitPromise: true,
      });
      await withTimeout(second.connected, 20_000, "reconnect after daemon restart");
      assert.equal(chrome.exitCode, null, "Chrome was restarted to reconnect");
      debug("reconnected without a Chrome restart");
    } finally {
      for (const core of cores) await core.close().catch(() => undefined);
      chrome.kill();
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => undefined,
      );
    }
  },
);

test(
  "a dropped native link heals itself without a daemon restart, a manual alarm or a Chrome restart",
  {
    skip:
      existsSync(chromePath) && existsSync(extension)
        ? false
        : "Chrome for Testing or the built extension is missing",
    timeout: 120_000,
  },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "graft-drop-heal-e2e-"));
    const chrome = spawn(
      chromePath,
      [
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        `--load-extension=${extension}`,
        `--disable-extensions-except=${extension}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--headless=new",
        ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    const core = await fakeCore();
    try {
      const port = await debugPort(profile);
      const worker = await waitForTarget(port, (item) => item.url.endsWith("/service-worker.js"));
      const cdp = await connect(worker.webSocketDebuggerUrl);
      for (let i = 0; i < 100; i++) {
        const ready = await cdp("Runtime.evaluate", {
          expression: "typeof chrome?.runtime?.id",
          returnByValue: true,
        });
        if (ready.result?.result?.value === "string") break;
        await sleep(100);
      }
      debug("worker ready");
      // One literal endpoint for the whole test: a drop does NOT move the endpoint and the daemon
      // process is never restarted. The extension must re-bootstrap and reconnect by itself.
      await cdp("Runtime.evaluate", {
        expression: `chrome.runtime.sendNativeMessage = (_host, request, callback) => callback({
          kind: "native.bootstrap.result", protocolVersion: request.protocolVersion, ok: true,
          endpoint: "ws://127.0.0.1:${core.port}/graft/v1", connectionGrant: "${"A".repeat(43)}",
          expiresAt: Date.now() + 600000, daemonProtocolVersion: request.protocolVersion });`,
      });
      const browserCdp = await connect(
        (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()))
          .webSocketDebuggerUrl,
      );
      await browserCdp("Target.createTarget", { url: "about:blank" });
      await withTimeout(core.connected, 20_000, "first connection");
      debug("link up");

      // Drop the daemon's side of the port. Nothing restarts: same endpoint, same daemon process,
      // same Chrome, and no alarm is fired by the test. The extension has to heal the link itself.
      core.drop();
      debug("dropped the native link; waiting for self-heal");
      await withTimeout(core.waitForConnection(2), 30_000, "self-heal after link drop");
      assert.equal(chrome.exitCode, null, "Chrome was restarted to reconnect");
      debug("link came back on its own");
    } finally {
      await core.close().catch(() => undefined);
      chrome.kill();
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => undefined,
      );
    }
  },
);

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out: " + label)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function fakeCore() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/graft/v1" });
  await new Promise((done) => server.once("listening", done));
  let socket;
  let connections = 0;
  const waiters = [];
  const connected = new Promise((done) =>
    server.on("connection", (ws) => {
      socket = ws;
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        if (message.kind === "auth.hello")
          ws.send(
            JSON.stringify({
              kind: "auth.ready",
              protocolVersion: message.protocolVersion,
              role: "extension-executor",
              connectionId: randomUUID(),
            }),
          );
        else if (message.kind === "browser.inventory.full") {
          ws.send(
            JSON.stringify({
              kind: "browser.inventory.applied",
              generation: message.generation,
              lastSequence: 0,
            }),
          );
          connections += 1;
          done();
          waiters.splice(0).forEach((waiter) => waiter(connections));
        } else if (message.kind === "browser.executor.heartbeat")
          ws.send(
            JSON.stringify({
              kind: "browser.executor.heartbeat.ack",
              clientInstanceId: message.clientInstanceId,
              browserRunId: message.browserRunId,
            }),
          );
      });
    }),
  );
  return {
    port: server.address().port,
    connected,
    count: () => connections,
    // Resolves once the extension has opened (and inventoried) the nth link on its own.
    waitForConnection(n) {
      if (connections >= n) return Promise.resolve(connections);
      return new Promise((done) => waiters.push(done));
    },
    drop() {
      socket?.close();
    },
    async close() {
      for (const client of server.clients) client.terminate();
      await new Promise((done) => server.close(done));
    },
  };
}

async function debugPort(profile) {
  for (let i = 0; i < 100; i++) {
    try {
      return Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
    } catch {
      await sleep(100);
    }
  }
  throw new Error("Chrome did not open a debugging port");
}

async function waitForTarget(port, match) {
  for (let i = 0; i < 100; i++) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(
      (r) => r.json(),
      () => [],
    );
    const found = targets.find(match);
    if (found) return found;
    await sleep(100);
  }
  throw new Error("Service worker target not found");
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  };
  return new Promise((ready) => {
    ws.onopen = () =>
      ready(
        (method, params = {}) =>
          new Promise((done) => {
            waiting.set(++id, done);
            ws.send(JSON.stringify({ id, method, params }));
          }),
      );
  });
}

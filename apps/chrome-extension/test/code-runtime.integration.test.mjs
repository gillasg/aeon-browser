/* eslint-disable max-lines-per-function -- one end-to-end scenario with its fake Core */
// End to end: the built extension in real Chrome, connected to a fake Core, running browser_code cells.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

const chromePath = resolve(
  ".slice0-audit/chrome-for-testing-154.0.8037.57/chrome-win64/chrome.exe",
);
const extension = resolve("apps/chrome-extension/native-dist");
const log = process.env.AEON_TEST_DEBUG
  ? (...parts) => process.stderr.write(parts.join(" ") + String.fromCharCode(10))
  : () => {};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

test(
  "browser_code cells run inside the extension against real Chrome",
  { skip: process.platform !== "win32" || !existsSync(chromePath) || !existsSync(extension) },
  async (t) => {
    const page = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(
        `<title>Fixture</title><h1>Shop</h1><input aria-label="Search"><button onclick="document.title='clicked'">Go</button>`,
      );
    });
    await new Promise((done) => page.listen(0, "127.0.0.1", done));
    const pageUrl = `http://127.0.0.1:${page.address().port}/`;
    const core = await fakeCore();
    const profile = await mkdtemp(join(tmpdir(), "aeon-code-runtime-"));
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
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    try {
      const port = await debugPort(profile);
      log("port", port);
      const worker = await waitForTarget(port, (item) => item.url.endsWith("/service-worker.js"));
      log("worker", worker.url);
      const cdp = await connect(worker.webSocketDebuggerUrl);
      for (let i = 0; i < 100; i++) {
        const ready = await cdp("Runtime.evaluate", {
          expression: "typeof chrome?.runtime?.id",
          returnByValue: true,
        });
        if (ready.result?.result?.value === "string") break;
        await sleep(100);
      }
      await cdp("Runtime.evaluate", {
        expression: `chrome.runtime.sendNativeMessage = (_host, request, callback) => callback({
          kind: "native.bootstrap.result", protocolVersion: request.protocolVersion, ok: true,
          endpoint: "ws://127.0.0.1:${core.port}/aeon/v1", connectionGrant: "${"A".repeat(43)}",
          expiresAt: Date.now() + 600000, daemonProtocolVersion: request.protocolVersion });`,
      });
      log("bootstrap overridden");
      await core.connected;
      const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
      const browserCdp = await connect(version.webSocketDebuggerUrl);
      await browserCdp("Target.createTarget", { url: pageUrl });
      const target = await core.target(pageUrl);
      log("target", JSON.stringify(target));
      const chatId = randomUUID();
      const run = (code) => core.run({ chatId, code, targets: [target] });

      await t.test("top-level bindings, functions and the last expression persist", async () => {
        assert.equal((await run("const n = 41; function seven() { return 7 }")).error, undefined);
        assert.equal((await run("n + 1")).value, 42);
        assert.equal((await run("let {a, b: [c]} = {a: 1, b: [2]}; seven() + a + c")).value, 10);
      });

      await t.test("bu.state observes the attached page and bu.click acts on its ids", async () => {
        const state = await run("await bu.state()");
        assert.match(state.output, /button "Go"/);
        const id = /\[(\d+)\] button "Go"/.exec(state.output)[1];
        const clicked = await run(
          `await bu.click(${id}); await page.evaluate(() => document.title)`,
        );
        assert.equal(clicked.error, undefined);
        assert.equal(clicked.value, "clicked");
        assert.ok(clicked.steps.some((step) => step.action?.op === "click"));
      });

      await t.test("the agent cursor appears without entering the page state", async () => {
        const result = await run(
          "await new Promise((r) => setTimeout(r, 50)); [!!document, await page.evaluate(() => !!document.getElementById('aeon-agent-cursor'))]",
        );
        assert.deepEqual(result.value, [true, true]);
        assert.doesNotMatch((await run("await bu.state()")).output, /aeon-agent-cursor/);
      });

      await t.test("labeled screenshots place ids on the elements and clean up", async () => {
        const result = await run(`
          await page.evaluate(() => { document.body.style.height = '3000px'; scrollTo(0, 400); });
          const id = /\\[(\\d+)\\] button "Go"/.exec(await bu.state()).at(1);
          const box = (await page.cdp('DOM.getBoxModel', { backendNodeId: Number(id) })).model.border;
          const rect = await page.evaluate(() => document.querySelector('button').getBoundingClientRect().top);
          const shot = await page.screenshot({ labels: true });
          [Math.round(Math.min(box[1], box[3])) === Math.round(rect), shot.kind, await page.evaluate(() => !!document.getElementById('aeon-labels'))]`);
        assert.equal(result.error, undefined);
        assert.deepEqual(result.value, [true, "screenshot", false]);
      });

      await t.test("a saved site skill is offered and loads in another chat", async () => {
        const saved = await run(
          "await skills.save({name: 'shop-title', domains: ['127.0.0.1'], description: 'Reads the shop title', code: \"var shop = {title: () => page.evaluate(() => document.title)}\"})",
        );
        assert.equal(saved.error, undefined);
        const other = (code) => core.run({ chatId: otherChat, code, targets: [] });
        const otherChat = randomUUID();
        const listed = await other(
          `page = await browser.openTab(${JSON.stringify(pageUrl)}); await bu.state()`,
        );
        assert.match(
          listed.output,
          /Site skills .*shop-title/,
          JSON.stringify(listed).slice(0, 400),
        );
        const used = await other("await skills.load('shop-title'); await shop.title()");
        assert.equal(used.error, undefined);
        assert.equal(used.value, "Fixture");
      });

      await t.test("workspace calls are served by Core", async () => {
        const result = await run("await checkpoint('progress.json', {done: 3})");
        assert.equal(result.error, undefined);
        assert.deepEqual(core.calls.at(-1), {
          workspace: "checkpoint",
          name: "progress.json",
          value: { done: 3 },
        });
      });

      await t.test("errors report without breaking the realm", async () => {
        assert.match((await run("this is not javascript")).error, /SyntaxError|Unexpected/);
        assert.match((await run("await page.cdp('Target.getTargets')")).error, /UNSUPPORTED/);
        assert.equal((await run("n")).value, 41);
      });

      await t.test("page calls stay inside the browser", async () => {
        const timed = await run(
          "const t0 = performance.now(); for (let i = 0; i < 50; i++) await page.evaluate(() => 1); (performance.now() - t0) / 50",
        );
        assert.equal(timed.error, undefined);
        t.diagnostic(`page.evaluate round trip: ${timed.value.toFixed(2)} ms`);
        assert.ok(timed.value < 50);
      });
    } finally {
      chrome.kill();
      core.close();
      page.close();
      await sleep(300);
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
    }
  },
);

async function fakeCore() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/aeon/v1" });
  await new Promise((done) => server.once("listening", done));
  let socket,
    tabs = [];
  const results = new Map();
  const calls = [];
  const skills = new Map();
  const connected = new Promise((done) =>
    server.on("connection", (ws) => {
      socket = ws;
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        log("core <-", message.kind, message.error ?? "");
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
          tabs = message.tabs;
          log("inventory", JSON.stringify(message.tabs.map((tab) => tab.url)));
          ws.send(
            JSON.stringify({
              kind: "browser.inventory.applied",
              generation: message.generation,
              lastSequence: 0,
            }),
          );
          done();
        } else if (message.kind === "browser.inventory.delta") {
          log("delta", JSON.stringify(message.delta).slice(0, 200));
          if (message.delta.kind === "tab.upsert")
            tabs = [
              ...tabs.filter((tab) => tab.target.tabId !== message.delta.tab.target.tabId),
              message.delta.tab,
            ];
          ws.send(
            JSON.stringify({
              kind: "browser.inventory.applied",
              generation: message.generation,
              lastSequence: message.sequence,
            }),
          );
        } else if (message.kind === "browser.executor.heartbeat")
          ws.send(
            JSON.stringify({
              kind: "browser.executor.heartbeat.ack",
              clientInstanceId: message.clientInstanceId,
              browserRunId: message.browserRunId,
            }),
          );
        else if (message.kind === "browser.code.call") {
          calls.push(message.request);
          if (message.request.siteSkill) {
            const request = message.request;
            const value =
              request.siteSkill === "save"
                ? (skills.set(request.skill.name, request.skill), { saved: request.skill.name })
                : request.siteSkill === "get"
                  ? skills.get(request.name)
                  : [...skills.values()].map(({ name, description }) => ({ name, description }));
            ws.send(
              JSON.stringify({
                kind: "browser.code.reply",
                cellId: message.cellId,
                callId: message.callId,
                value,
              }),
            );
            return;
          }
          ws.send(
            JSON.stringify({
              kind: "browser.code.reply",
              cellId: message.cellId,
              callId: message.callId,
              value: { path: "C:/workspace/" + message.request.name },
            }),
          );
        } else if (message.kind === "browser.code.result") results.get(message.cellId)?.(message);
      });
    }),
  );
  return {
    port: server.address().port,
    calls,
    connected,
    async target(url) {
      for (let i = 0; i < 80; i++) {
        const tab = tabs.find((item) => item.url === url && item.status === "complete");
        if (tab) return tab.target;
        await sleep(100);
      }
      throw new Error("Fixture tab never appeared in the inventory");
    },
    run({ chatId, code, targets }) {
      const cellId = randomUUID();
      const result = new Promise((done) => results.set(cellId, done));
      socket.send(
        JSON.stringify({
          kind: "browser.code.run",
          cellId,
          chatId,
          toolCallId: "test",
          code,
          targets,
          timeoutMs: 20000,
        }),
      );
      return Promise.race([result, sleep(25000).then(() => ({ error: "test timeout" }))]);
    },
    close: () => server.close(),
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
  throw new Error("Target not found");
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

/**
 * End to end: the built extension's Chat page, a fake Core, and real Chrome. Clicking
 * "Add or manage models…" opens Aeon's Models page in a new tab.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { WebSocketServer } from "ws";

const chromePath = resolve(
  ".slice0-audit/chrome-for-testing-154.0.8037.57/chrome-win64/chrome.exe",
);
const extension = resolve("apps/chrome-extension/native-dist");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const chatId = randomUUID();
const model = {
  provider: "opencode-go",
  id: "deepseek-v4.1-flash",
  name: "DeepSeek V4.1 Flash",
  thinkingLevels: ["low"],
  defaultThinkingLevel: "low",
};

test(
  "Add or manage models opens the Models page from a Chat",
  { skip: process.platform !== "win32" || !existsSync(chromePath) || !existsSync(extension) },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "aeon-model-sign-in-"));
    const page = await signInPage();
    const core = await fakeCore(page.url);
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
      const worker = await waitForTarget(port, (item) => item.url.endsWith("/service-worker.js"));
      const extensionId = new URL(worker.url).host;
      const { browser, sessionId } = await openChatPage(
        port,
        extensionId,
        `ws://127.0.0.1:${core.port}/aeon/v1`,
      );
      await clickManageModels(browser, sessionId);
      const models = `chrome-extension://${extensionId}/home.html?view=models`;
      const opened = await waitForTarget(port, (item) => item.url.startsWith(models));
      assert.equal(opened.url, models);
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

function signInPage() {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<title>Model sign-in</title><h1>Sign in</h1>");
  });
  return new Promise((ready) => {
    server.listen(0, "127.0.0.1", () =>
      ready({
        url: `http://127.0.0.1:${server.address().port}/sign-in`,
        close: () => server.close(),
      }),
    );
  });
}

async function fakeCore(signInUrl) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/aeon/v1" });
  await once(server, "listening");
  let loginSeen;
  const loginSeenPromise = new Promise((done) => (loginSeen = done));
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.kind === "auth.hello")
        return socket.send(
          JSON.stringify({
            kind: "auth.ready",
            protocolVersion: message.protocolVersion,
            role: "ui",
            connectionId: randomUUID(),
          }),
        );
      if (message.kind === "ping")
        return socket.send(JSON.stringify({ kind: "pong", requestId: message.requestId }));
      if (message.kind === "chat.subscribe")
        return socket.send(JSON.stringify(snapshot(message.requestId)));
      if (message.kind !== "command") return;
      if (message.operation === "chat.model-login") {
        loginSeen();
        return socket.send(
          JSON.stringify(completed(message, { kind: "chat.model-login", url: signInUrl })),
        );
      }
      const result = results[message.operation];
      if (result) return socket.send(JSON.stringify(completed(message, result)));
      socket.send(
        JSON.stringify({
          kind: "command.failed",
          requestId: message.requestId,
          operation: message.operation,
          code: "INVALID_COMMAND",
          message: "Not needed by this test.",
        }),
      );
    });
  });
  return { port: server.address().port, loginSeen: loginSeenPromise, close: () => server.close() };
}

const results = {
  "chat.controls": {
    kind: "chat.controls",
    controls: {
      effectiveModel: { provider: model.provider, id: model.id, name: model.name },
      availableModels: [model],
      thinkingLevel: "low",
      availableThinkingLevels: ["low"],
      steeringQueue: [],
      followUpQueue: [],
      active: false,
    },
  },
  "chat.pi-ui": {
    kind: "chat.pi-ui",
    piUi: { tree: [], slashCommands: [], extensionDialogs: [], notices: [] },
  },
};

function completed(message, result) {
  return {
    kind: "command.completed",
    requestId: message.requestId,
    operation: message.operation,
    result,
  };
}

function snapshot(requestId) {
  const at = new Date().toISOString();
  return {
    kind: "chat.snapshot",
    requestId,
    subscriptionId: randomUUID(),
    cursor: { epoch: randomUUID(), revision: 0 },
    snapshot: {
      chat: {
        chatId,
        title: "Model sign-in",
        projectId: null,
        pinned: false,
        archived: false,
        status: "ready",
        createdAt: at,
        updatedAt: at,
      },
      runState: "idle",
      contextUsage: null,
      entries: [
        {
          entryId: "entry-1",
          parentEntryId: null,
          category: "message",
          timestamp: at,
          message: { role: "user", content: [{ type: "text", text: "Hello" }] },
        },
      ],
      omittedEntryCount: 0,
    },
  };
}

function bootstrap(endpoint) {
  return `
    globalThis.__aeonTestErrors = [];
    addEventListener("error", (event) =>
      globalThis.__aeonTestErrors.push(String(event.error?.stack ?? event.message)));
    addEventListener("unhandledrejection", (event) =>
      globalThis.__aeonTestErrors.push(String(event.reason?.stack ?? event.reason)));
    globalThis.chrome.runtime.sendMessage = async (message) => {
      if (message?.kind === "aeon.native.page-grant") return {
        ok: true,
        endpoint: ${JSON.stringify(endpoint)},
        connectionGrant: "${"A".repeat(43)}",
        expiresAt: Date.now() + 600000,
        protocolVersion: { major: 1, minor: 7 },
        clientInstanceId: crypto.randomUUID(),
        browserRunId: crypto.randomUUID(),
        pageInstanceId: message.pageInstanceId,
        scope: message.scope,
      };
      if (message?.kind === "aeon.native.take-initial-submit")
        return { ok: false, code: "INITIAL_SUBMIT_UNAVAILABLE" };
      return {};
    };
  `;
}

async function openChatPage(port, extensionId, endpoint) {
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((reply) =>
    reply.json(),
  );
  const browser = await connect(version.webSocketDebuggerUrl);
  const created = await browser("Target.createTarget", { url: "about:blank" });
  const attached = await browser("Target.attachToTarget", {
    targetId: created.result.targetId,
    flatten: true,
  });
  const sessionId = attached.result.sessionId;
  await browser("Page.enable", {}, sessionId);
  await browser(
    "Page.addScriptToEvaluateOnNewDocument",
    { source: bootstrap(endpoint) },
    sessionId,
  );
  await browser(
    "Page.navigate",
    { url: `chrome-extension://${extensionId}/chat.html?chatId=${chatId}` },
    sessionId,
  );
  return { browser, sessionId };
}

async function clickManageModels(browser, sessionId) {
  await waitFor(browser, sessionId, "!!document.querySelector('#model-picker')");
  await evaluate(
    browser,
    sessionId,
    `(() => {
      const picker = document.querySelector('#model-picker');
      const details = picker?.closest('details');
      if (details) details.open = true;
      document.querySelector('.pi-picker-manage')?.click();
      return true;
    })()`,
  );
}

async function waitFor(browser, sessionId, expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(browser, sessionId, expression)) return;
    await sleep(100);
  }
  const state = await evaluate(
    browser,
    sessionId,
    "JSON.stringify({url: location.href, title: document.title, text: document.body?.innerText?.slice(0, 500), connection: document.getElementById('connection-state')?.innerText, errors: globalThis.__aeonTestErrors})",
  ).catch((error) => String(error));
  throw new Error("Chat page did not reach the expected state: " + state);
}

async function evaluate(browser, sessionId, expression) {
  const reply = await browser(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (reply.result.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
  return reply.result.result.value;
}

async function debugPort(profile) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
    } catch {
      await sleep(100);
    }
  }
  throw new Error("Chrome did not open a debugging port");
}

async function waitForTarget(port, match) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(
      (reply) => reply.json(),
      () => [],
    );
    const found = targets.find(match);
    if (found) return found;
    await sleep(100);
  }
  throw new Error("Target not found");
}

function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const waiting = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  };
  return new Promise((ready) => {
    socket.onopen = () =>
      ready(
        (method, params = {}, sessionId) =>
          new Promise((done) => {
            waiting.set(++nextId, done);
            socket.send(JSON.stringify({ id: nextId, method, params, sessionId }));
          }),
      );
  });
}

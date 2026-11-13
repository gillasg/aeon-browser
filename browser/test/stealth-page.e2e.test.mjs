// What a page can see of Aeon when it is not driving it, and while it is: no page globals, the
// settle probe's observer kept in its own world, and nothing of ours on the page but the cursor.
// Run alone: node --test test/stealth-page.e2e.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";

const chromePath =
  process.env.CHROME_PATH ??
  resolve("../.slice0-audit/chrome-for-testing-154.0.8037.57/chrome-win64/chrome.exe");
const extension = resolve("apps/extension/build");
const cli = resolve("apps/bridge/dist/cli.js");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = promisify(execFile);

const pageHtml = `<title>Quiet</title>
<main><h1>Nothing here</h1><p>A page with no agent on it.</p></main>
<button id="go" onclick="document.title='continued'">Go</button>`;

test(
  "a page carries no agent globals or overlays until Aeon drives it, and the settle probe stays out of its world",
  { skip: !process.env.REQUIRE_E2E && !existsSync(chromePath) },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-stealth-page-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const site = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(pageHtml);
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-stealth-page-chrome-"));
    let chrome;
    try {
      await waitFor(async () => JSON.parse(await readFile(join(home, "bridge.json"), "utf8")));
      chrome = spawn(chromePath, chromeArgs(profile), { stdio: "ignore" });
      const port = await connectExtension(profile, env);

      // A tab Aeon never drove: the page's own world carries nothing of ours.
      const idle = await untouchPage(port, url);
      assert.deepEqual(idle.globals, [], "a page global was left on an idle page");
      assert.deepEqual(idle.overlays, [], "an overlay was left on an idle page");

      const result = await run(
        process.execPath,
        [cli, "repl", "--session", "stealth-page", repl(url)],
        { env },
      );
      const shown = JSON.parse(/STEALTH (.*)/.exec(result.stdout)?.[1] ?? "null");
      assert.ok(shown, result.stdout + result.stderr);
      // The settle probe ran on this tab (openTab waits for it) and lives in its own world.
      assert.deepEqual(shown.main.globals, [], "the settle probe left a page global");
      assert.deepEqual(shown.report.probe.globals, [], result.stdout);
      assert.ok(
        shown.report.diagnostics.some((line) => /settle probe \(isolated world\)/.test(line)),
        result.stdout,
      );
      assert.ok(
        !shown.report.signals.some((line) => /settle probe|page's own world/.test(line)),
        `an isolated-world helper was reported as a page-visible tell: ${result.stdout}`,
      );
      // The only thing of ours on a driven page is the cursor that is drawing.
      assert.deepEqual(shown.main.overlays, ["#aeon-agent-cursor"], result.stdout);
    } finally {
      chrome?.kill();
      bridge.kill();
      site.close();
      await sleep(200);
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
    }
  },
  60000,
);

function repl(url) {
  return `page = await browser.openTab(${JSON.stringify(url)});
    const report = await page.stealthCheck();
    const main = await page.evaluate(() => ({
      globals: Object.getOwnPropertyNames(window).filter((name) => /^(__aeon|__browserkit)/.test(name)),
      overlays: [...document.querySelectorAll('[id^="aeon-"],[data-aeon-overlay]')].map((node) => node.id ? '#' + node.id : node.tagName.toLowerCase())
    }));
    console.log("STEALTH " + JSON.stringify({report, main}));`;
}

/** A tab opened outside Aeon: no debugger, no glow, nothing of the extension in it. */
async function untouchPage(port, url) {
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const browser = connect(version.webSocketDebuggerUrl);
  await browser.opened;
  const made = await browser.send("Target.createTarget", { url });
  const targetId = made.result.targetId;
  const target = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const found = targets.find((item) => item.id === targetId && item.webSocketDebuggerUrl);
    if (!found) throw new Error("no page target yet");
    return found;
  });
  const page = connect(target.webSocketDebuggerUrl);
  await page.opened;
  await waitFor(async () => {
    const ready = await page.send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
    if (ready.result?.result?.value !== "complete") throw new Error("page not loaded");
  });
  const dom = await page.send("Runtime.evaluate", {
    expression: `(() => ({
      globals: Object.getOwnPropertyNames(window).filter((name) => /^(__aeon|__browserkit)/.test(name)),
      overlays: [...document.querySelectorAll('[id^="aeon-"],[id^="browserkit-"],[data-aeon-overlay]')].map((node) => node.id ? '#' + node.id : node.tagName.toLowerCase())
    }))()`,
    returnByValue: true,
  });
  return dom.result.result.value;
}

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

async function connectExtension(profile, env) {
  const port = await waitFor(async () =>
    Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]),
  );
  const worker = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((item) => item.json());
    const found = targets.find((item) => item.url.endsWith("/service-worker.js"));
    if (!found) throw new Error("no worker yet");
    return found;
  });
  const reply = await nativeBootstrap(env);
  const cdp = connect(worker.webSocketDebuggerUrl);
  await cdp.opened;
  await waitFor(async () => {
    const ready = await cdp.send("Runtime.evaluate", {
      expression: "typeof chrome?.runtime?.id",
      returnByValue: true,
    });
    if (ready.result?.result?.value !== "string") throw new Error("worker not ready");
  });
  await cdp.send("Runtime.evaluate", {
    expression: `chrome.runtime.sendNativeMessage = (_host, request, callback) => callback(${JSON.stringify(reply)});`,
  });
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((item) => item.json());
  const browser = connect(version.webSocketDebuggerUrl);
  await browser.opened;
  await browser.send("Target.createTarget", { url: "about:blank" });
  await waitFor(async () => {
    const { stdout } = await run(process.execPath, [cli, "status"], { env });
    if (!/1 browser/.test(stdout)) throw new Error(stdout);
  }, 30000);
  return port;
}

function nativeBootstrap(env) {
  return new Promise((resolveReply, reject) => {
    const host = spawn(
      process.execPath,
      [cli, "chrome-extension://dmlgohfphkbenjopdphcojgjeidlmajj/"],
      { env },
    );
    const chunks = [];
    host.stdout.on("data", (chunk) => chunks.push(chunk));
    host.on("error", reject);
    host.on("close", () => {
      const buffer = Buffer.concat(chunks);
      resolveReply(JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString("utf8")));
    });
    const body = Buffer.from(
      JSON.stringify({
        kind: "native.bootstrap",
        protocolVersion: { major: 1, minor: 6 },
        clientInstanceId: "091b9308-1ee9-420e-b71f-a564a5a27701",
        browserRunId: "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8",
      }),
    );
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    host.stdin.end(Buffer.concat([header, body]));
  });
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
    if (message.id === undefined) return;
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  const opened = new Promise((done) => socket.once("open", done));
  return {
    opened,
    send: async (method, params = {}) => {
      await opened;
      const callId = ++id;
      socket.send(JSON.stringify({ id: callId, method, params }));
      return new Promise((done) => waiting.set(callId, done));
    },
  };
}

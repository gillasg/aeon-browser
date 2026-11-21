// Real Chrome: a watcher fires on a response the fixture page polls itself, with no timer tick.
// The browser code under test is the code the daemon generates for a `listen` routine, imported
// from the daemon build so the e2e exercises the exact shipped generator.
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
import { liveCheckCode } from "../../apps/daemon/dist/routine-listen.js";
import { chromePort } from "./helpers/chrome-port.mjs";

const chromePath =
  process.env.CHROME_PATH ??
  resolve("../.slice0-audit/chrome-for-testing-157.0.8103.78/chrome-win64/chrome.exe");
const extension = resolve("apps/extension/build");
const cli = resolve("apps/bridge/dist/cli.js");
const run = promisify(execFile);

// The check a listen routine runs against each matching response body. It keeps its "new since
// last time" state in browser.changes, exactly as a timer check does. The last expression is the
// cell's value; console.log makes the value visible in the REPL for the assertions below.
const CHECK = `const r = browser.changes('live-status', response.body.items);
const fired = r.new.length ? r.new : false;
console.log("FIRED " + JSON.stringify(fired));
fired`;

test(
  "live watcher fires on the page's own JSON response, not on a timer",
  { skip: !process.env.REQUIRE_E2E && !existsSync(chromePath) },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-live-watch-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    let payload = { items: [{ id: "a", title: "A" }] };
    let hits = 0;
    const site = createServer((request, response) => {
      if (request.url.startsWith("/api/status")) {
        hits += 1;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(payload));
        return;
      }
      response.setHeader("content-type", "text/html");
      // The page polls a JSON endpoint on its own; Aeon never re-requests it.
      response.end(`<!doctype html><title>Status board</title><div id="rows">-</div>
        <script>setInterval(() => fetch('/api/status').then((r) => r.json()).then((d) => {
          document.getElementById('rows').textContent = d.items.map((i) => i.id).join(',');
        }), 700);</script>`);
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${site.address().port}/`;
    const generated = liveCheckCode(CHECK, { url: "/api/status", type: "json" }, ["127.0.0.1"]);
    assert.match(generated, /waitForResponse\("\/api\/status", \{type: "json"/);
    assert.doesNotMatch(generated, /browser\.openTab\(/);

    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-live-watch-chrome-"));
    let chrome;
    try {
      await waitFor(async () => JSON.parse(await readFile(join(home, "bridge.json"), "utf8")));
      chrome = spawn(
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
      await connectExtension(profile, env);

      // Open the fixture page in the user's Chrome and leave it there for the watcher to attach.
      await repl(
        `page = await browser.openTab(${JSON.stringify(url)}); await page.waitForSelector('#rows'); 'opened'`,
        env,
      );
      await waitFor(async () => {
        if (hits < 1) throw new Error("the page has not polled yet");
        return true;
      });
      const before = hits;

      // First live check establishes the baseline (the existing 'a' is not new): no fire.
      const started = Date.now();
      const first = await repl(generated, env);
      const firstMs = Date.now() - started;
      assert.match(first.stdout, /FIRED false/);

      // The page adds a row on its own. No Aeon timer tick, no new request from Aeon.
      payload = {
        items: [
          { id: "a", title: "A" },
          { id: "b", title: "B" },
        ],
      };
      await waitFor(async () => {
        if (hits < before + 2) throw new Error("the page has not polled the new payload yet");
        return true;
      });
      const second = await repl(generated, env);
      assert.match(second.stdout, /FIRED \[/);
      assert.match(second.stdout, /"id":"b"/);
      assert.match(second.stdout, /"title":"B"/);

      // The same response again is not new: the watcher does not fire twice (dedupe).
      const third = await repl(generated, env);
      assert.match(third.stdout, /FIRED false/);
      process.stdout.write(
        `live watcher: baseline ${firstMs} ms, page polls ${hits}, fired on the new row without a timer tick\n`,
      );
    } finally {
      await stopChrome(chrome);
      bridge.kill();
      site.close();
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

function repl(code, env) {
  return run(process.execPath, [cli, "repl", "--session", "live-watchers", code], { env });
}

async function stopChrome(chrome) {
  if (!chrome || chrome.exitCode !== null || chrome.signalCode !== null) return;
  const exited = new Promise((done) => chrome.once("exit", done));
  try {
    chrome.kill();
  } catch {
    return;
  }
  if (chrome.exitCode === null && chrome.signalCode === null) await exited;
}

async function connectExtension(profile, env) {
  const port = await chromePort(profile);
  const worker = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
      response.json(),
    );
    const found = targets.find((item) => item.url.endsWith("/service-worker.js"));
    if (!found) throw new Error("no worker yet");
    return found;
  }, 60000);
  const reply = await nativeBootstrap(env);
  const cdp = await connect(worker.webSocketDebuggerUrl);
  await cdp("Runtime.evaluate", {
    expression: `chrome.runtime.sendNativeMessage = (_host, request, callback) => callback(${JSON.stringify(reply)});`,
  });
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) =>
    response.json(),
  );
  const browser = await connect(version.webSocketDebuggerUrl);
  await browser("Target.createTarget", { url: "about:blank" });
  await waitFor(async () => {
    const { stdout } = await run(process.execPath, [cli, "status"], { env });
    if (!/1 browser/.test(stdout)) throw new Error(stdout);
  });
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
      await new Promise((done) => setTimeout(done, 100));
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

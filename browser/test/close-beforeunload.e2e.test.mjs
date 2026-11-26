// An agent closing a tab whose page guards beforeunload: Chrome raises the leave dialog only after
// a user gesture, so the cell clicks and types first. The close must finish within 2 s and leave
// no tab behind, and the next close must not queue behind it.
// Real Chrome: CHROME_PATH=<chrome-for-testing 157> node --test test/close-beforeunload.e2e.test.mjs
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
import { chromePort } from "./helpers/chrome-port.mjs";

const chromePath =
  process.env.CHROME_PATH ??
  resolve("../.slice0-audit/chrome-for-testing-157.0.8103.78/chrome-win64/chrome.exe");
const extension = resolve("apps/extension/build");
const cli = resolve("apps/bridge/dist/cli.js");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = promisify(execFile);

const pages = {
  "/guard": `<title>Guard</title><script>
    addEventListener('beforeunload', (event) => { event.preventDefault(); event.returnValue = ''; });
    </script><input id="field"><button id="go" onclick="document.title='touched'">go</button>`,
  "/plain": `<title>Plain</title><p>plain</p>`,
};

async function checkGuardedClose(cell, logged, origin) {
  const closed =
    await cell(`const page = await browser.openTab(${JSON.stringify(origin + "/guard")}, {newTab: true});
    await page.click("#go");
    await page.type("#field", "unsaved");
    const armed = await page.evaluate(() => navigator.userActivation.hasBeenActive);
    const started = Date.now();
    await browser.closeTab(page);
    const ms = Date.now() - started;
    const left = (await browser.tabs()).filter((tab) => tab.url.includes("/guard")).length;
    const next = await browser.openTab(${JSON.stringify(origin + "/plain")}, {newTab: true});
    const again = Date.now();
    await browser.closeTab(next);
    const nextMs = Date.now() - again;
    const plainLeft = (await browser.tabs()).filter((tab) => tab.url.includes("/plain")).length;
    console.log("CLOSE " + JSON.stringify({ armed, ms, left, nextMs, plainLeft }));`);
  const row = logged(closed.stdout, "CLOSE");
  assert.equal(row.armed, true, closed.stdout);
  assert.ok(row.ms < 2_000, closed.stdout);
  assert.equal(row.left, 0, closed.stdout);
  assert.ok(row.nextMs < 2_000, closed.stdout);
  assert.equal(row.plainLeft, 0, closed.stdout);
}

test(
  "an agent closes a beforeunload-guarded tab at once, and the next close is not held",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-close-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const site = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      response.end(pages[path] ?? "<title>Missing</title>");
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${site.address().port}`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-close-chrome-"));
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
      const cell = (code) =>
        run(process.execPath, [cli, "repl", "--session", "close-guard", code], {
          env,
          timeout: 90_000,
        });
      const logged = (stdout, name) => JSON.parse(new RegExp(name + " (.*)").exec(stdout)[1]);
      await checkGuardedClose(cell, logged, origin);
    } finally {
      chrome?.kill();
      bridge.kill();
      site.close();
      await sleep(300);
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
    }
  },
);
async function connectExtension(profile, env) {
  const port = await chromePort(profile);
  const worker = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const found = targets.find((item) => item.url.endsWith("/service-worker.js"));
    if (!found) throw new Error("no worker yet");
    return found;
  }, 60000);
  const reply = await nativeBootstrap(env);
  const cdp = await connect(worker.webSocketDebuggerUrl);
  await waitFor(async () => {
    const ready = await cdp("Runtime.evaluate", {
      expression: "typeof chrome?.runtime?.id",
      returnByValue: true,
    });
    if (ready.result?.result?.value !== "string") throw new Error("worker not ready");
  });
  await cdp("Runtime.evaluate", {
    expression: `chrome.runtime.sendNativeMessage = (_host, request, callback) => callback(${JSON.stringify(reply)});`,
  });
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const browser = await connect(version.webSocketDebuggerUrl);
  await browser("Target.createTarget", { url: "about:blank" });
  await waitFor(async () => {
    const { stdout } = await run(process.execPath, [cli, "status"], { env });
    if (!/1 browser/.test(stdout)) throw new Error(stdout);
  }, 30000);
  return cdp;
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
      await sleep(150);
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
    return new Promise((done) => {
      waiting.set(++id, done);
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
}

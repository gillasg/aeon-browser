// Real Chrome: locator.waitFor and page.waitForSelector honor attached/detached/visible/hidden.
// Run alone, from browser/: node --test test/wait-state.e2e.test.mjs
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
  resolve("../.slice0-audit/chrome-for-testing-157.0.8103.78/chrome-win64/chrome.exe");
const extension = resolve("apps/extension/build");
const cli = resolve("apps/bridge/dist/cli.js");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = promisify(execFile);

const pageHtml = `<!doctype html><title>Waits</title>
<div id="box">box</div>
<div id="spinner">spinner</div>
<div id="later" style="display:none">later</div>
<div id="vis" style="visibility:hidden;width:40px;height:20px">vis</div>
<div id="stay" style="display:none">stay</div>`;

test(
  "waitFor and waitForSelector honor attached, detached, visible and hidden",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-wait-state-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const site = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(pageHtml);
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-wait-state-chrome-"));
    let chrome;
    try {
      await waitFor(async () => JSON.parse(await readFile(join(home, "bridge.json"), "utf8")));
      chrome = spawn(chromePath, chromeArgs(profile), { stdio: "ignore" });
      await connectExtension(profile, env);
      const result = await repl(env, cell(url));
      const out = `${result.stdout}\n${result.stderr}`;
      assert.match(out, /NEG_DEFAULT ERR TIMEOUT[^\n]*visible/, out);
      assert.match(out, /NEG_VISIBLE ERR TIMEOUT[^\n]*visible/, out);
      assert.match(out, /NEG_HIDDEN ERR TIMEOUT[^\n]*hidden/, out);
      assert.match(out, /NEG_DETACHED ERR TIMEOUT[^\n]*detached/, out);
      assert.match(out, /NEG_ATTACHED ERR TIMEOUT[^\n]*attached/, out);
      assert.match(out, /POS_VISIBLE ok shown/, out);
      assert.match(out, /POS_VISIBILITY ok shown/, out);
      assert.match(out, /POS_HIDDEN ok hidden/, out);
      assert.match(out, /POS_DETACHED ok gone/, out);
      assert.match(out, /POS_ATTACHED ok hidden/, out);
      assert.match(out, /BADSTATE ERR INVALID_INPUT/, out);
      assert.doesNotMatch(out, /EARLY/, out);
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
  120000,
);

function cell(url) {
  return `const page = await browser.openTab(${JSON.stringify(url)});
async function mustMiss(label, run) {
  const started = Date.now();
  let status = "ok";
  try { await run(); }
  catch (error) { status = "ERR " + String(error && error.message || error).split("\\n")[0]; }
  console.log(label + " " + status + " " + (Date.now() - started));
}
await Promise.all([
  mustMiss("NEG_DEFAULT", () => page.locator("#stay").waitFor({ timeout: 900 })),
  mustMiss("NEG_VISIBLE", () => page.locator("#stay").waitFor({ state: "visible", timeout: 900 })),
  mustMiss("NEG_HIDDEN", () => page.locator("#spinner").waitFor({ state: "hidden", timeout: 900 })),
  mustMiss("NEG_DETACHED", () => page.waitForSelector("#box", { state: "detached", timeout: 900 })),
  mustMiss("NEG_ATTACHED", () => page.locator("#absent").waitFor({ state: "attached", timeout: 900 })),
]);
async function settle(promise) {
  const box = { status: "pending" };
  const done = promise.then(
    () => { box.status = "ok"; },
    (error) => { box.status = "ERR " + String(error && error.message || error).split("\\n")[0]; },
  );
  for (let i = 0; i < 3 && box.status === "pending"; i++) await page.evaluate(() => 1);
  return { box, done };
}
async function fact(selector) {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return "gone";
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const shown = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
    return shown ? "shown" : "hidden";
  }, selector);
}
async function mustReach(label, start, flip, read) {
  const watch = await settle(start());
  if (watch.box.status !== "pending") {
    console.log(label + " EARLY " + watch.box.status);
    return;
  }
  await flip();
  await watch.done;
  console.log(label + " " + watch.box.status + " " + (await read()));
}
await mustReach(
  "POS_VISIBLE",
  () => page.locator("#later").waitFor({ timeout: 4000 }),
  () => page.evaluate(() => { document.querySelector("#later").style.display = "block"; }),
  () => fact("#later"),
);
await mustReach(
  "POS_VISIBILITY",
  () => page.waitForSelector("#vis", { state: "visible", timeout: 4000 }),
  () => page.evaluate(() => { document.querySelector("#vis").style.visibility = "visible"; }),
  () => fact("#vis"),
);
await mustReach(
  "POS_HIDDEN",
  () => page.locator("#spinner").waitFor({ state: "hidden", timeout: 4000 }),
  () => page.evaluate(() => { document.querySelector("#spinner").style.display = "none"; }),
  () => fact("#spinner"),
);
await mustReach(
  "POS_DETACHED",
  () => page.locator("#box").waitFor({ state: "detached", timeout: 4000 }),
  () => page.evaluate(() => { document.querySelector("#box").remove(); }),
  () => fact("#box"),
);
await mustReach(
  "POS_ATTACHED",
  () => page.waitForSelector("#born", { state: "attached", timeout: 4000 }),
  () => page.evaluate(() => {
    const born = document.createElement("div");
    born.id = "born";
    born.style.display = "none";
    born.textContent = "born";
    document.body.append(born);
  }),
  () => fact("#born"),
);
let bad = "ok";
try { await page.locator("#stay").waitFor({ state: "elsewhere", timeout: 500 }); }
catch (error) { bad = "ERR " + String(error && error.message || error).split("\\n")[0]; }
console.log("BADSTATE " + bad);`;
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

async function repl(env, code) {
  try {
    return await run(
      process.execPath,
      [cli, "repl", "--session", "wait-state", "--timeout", "60000", code],
      { env, maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (error) {
    return {
      stdout: error.stdout ?? "",
      stderr: `${error.stderr ?? ""}\n${error.message ?? ""}`,
    };
  }
}

async function connectExtension(profile, env) {
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
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) =>
    response.json(),
  );
  const browser = await connect(version.webSocketDebuggerUrl);
  await browser("Target.createTarget", { url: "about:blank" });
  await waitFor(async () => {
    const { stdout } = await run(process.execPath, [cli, "status"], { env });
    if (!/1 browser/.test(stdout)) throw new Error(stdout);
  }, 30000);
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

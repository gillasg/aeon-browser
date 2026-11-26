// Real Chrome: page.cause(action) names the api parameter a click changed, counts the beacon as
// noise and reports the store and DOM changes. Run alone, from browser/: node --test test/page-cause.e2e.test.mjs
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

const pageHtml = `<!doctype html><title>Cause</title>
<button type="button" id="tech" style="width:120px;height:40px">Tech</button>
<ul id="list"><li>loading</li></ul>
<script>
var state = {filter: "all", count: 0}, subs = [];
window.__STORE__ = {getState: () => state, subscribe: (fn) => subs.push(fn), dispatch: (a) => { state = Object.assign({}, state, a.payload); subs.forEach((fn) => fn()); }};
async function load(cat, cursor) {
  var rows = await fetch("/api/items?cat=" + cat + "&cursor=" + cursor).then((r) => r.json());
  document.getElementById("list").innerHTML = rows.map((r) => "<li>" + r + "</li>").join("");
  __STORE__.dispatch({type: "set", payload: {filter: cat, count: rows.length}});
}
load("all", 1);
document.getElementById("tech").onclick = () => { fetch("/collect", {method: "POST", body: "e=click"}); load("tech", 2); };
</script>`;

test(
  "page.cause reports the changed api parameter, the beacon, the store and the DOM",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-page-cause-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const site = createServer((request, response) => {
      if (request.url.startsWith("/api/items")) {
        const cat = new URL(request.url, "http://x").searchParams.get("cat");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify([cat + " one", cat + " two"]));
        return;
      }
      if (request.url.startsWith("/collect")) {
        response.statusCode = 204;
        response.end();
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(pageHtml);
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-page-cause-chrome-"));
    let chrome;
    try {
      await waitFor(async () => JSON.parse(await readFile(join(home, "bridge.json"), "utf8")));
      chrome = spawn(chromePath, chromeArgs(profile), { stdio: "ignore" });
      await connectExtension(profile, env);
      const result = await repl(env, cell(url));
      const out = `${result.stdout}\n${result.stderr}`;
      const fx = JSON.parse(/FX (.*)/.exec(out)?.[1] ?? "null");
      assert.ok(fx, out);
      const api = fx.requests.filter((r) => r.kind === "api");
      assert.equal(api.length, 1, out);
      assert.deepEqual(api[0].diff.query.cat, ["all", "tech"], out);
      assert.ok(fx.noise.tracker + fx.noise.beacon >= 1, out);
      assert.ok(fx.dom.added > 0 || fx.dom.changedText > 0, out);
      assert.ok(
        fx.stores.some((s) => /filter$/.test(s.path) && s.after === "tech"),
        out,
      );
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
await page.network.start();
await page.evaluate(() => { window.__STORE__.dispatch({payload: {count: 0}}); load("all", 1); });
for (let i = 0; i < 50 && !(await page.inspect(() => window.__STORE__.getState().count === 2)); i++) await new Promise((d) => setTimeout(d, 100));
const fx = await page.cause(() => page.locator("#tech").click(), {settleMs: 1500});
console.log("FX " + JSON.stringify(fx));`;
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
      [cli, "repl", "--session", "page-cause", "--timeout", "90000", code],
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

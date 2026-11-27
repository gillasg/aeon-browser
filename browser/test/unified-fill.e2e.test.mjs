// Real Chrome: an indexed locator.fill() goes through the engine's verified fill, picks the copy
// on screen, refuses one stuck off-screen with TARGET_HIDDEN, and commits on request.
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

const PAGE = `<title>fill</title>
<style>.bar{position:fixed;top:0;left:0;right:0}</style>
<div class="bar" style="transform:translateY(-200%)"><input class="q" placeholder="Search"></div>
<div class="bar" style="transform:translateY(-500px)"><input id="stuck"></div>
<p style="margin-top:80px"><input class="vue"> <span id="model"></span></p>
<p><input class="q" id="visible" placeholder="Search"></p>
<p><input id="enter"> <input id="blur"> <input id="change"></p>
<script>
  // Vue-style controlled input: the model follows input events only while the document has
  // focus, and every render writes the model back, so a value set any other way is undone.
  var vue = document.querySelector('.vue'), model = '';
  vue.addEventListener('input', () => { if (document.hasFocus()) model = vue.value; vue.value = model; document.getElementById('model').textContent = model; });
  window.commits = {enter: 0, blur: 0, change: 0};
  document.getElementById('enter').addEventListener('keydown', (e) => { if (e.key === 'Enter') commits.enter++; });
  document.getElementById('blur').addEventListener('blur', () => commits.blur++);
  document.getElementById('change').addEventListener('change', () => commits.change++);
</script>`;
const SCRIPT = `page = await browser.openTab(URL);
var r = await page.locator('input.vue').first().fill('frieren');
console.log('A ' + JSON.stringify({value: r.value, via: r.via, committed: r.committed, model: await page.locator('#model').innerText()}));
await page.getByPlaceholder('Search').first().fill('found');
console.log('B ' + JSON.stringify({visible: await page.locator('#visible').inputValue(), hidden: await page.locator('.bar input.q').inputValue()}));
try { await page.locator('#stuck').first().fill('x'); console.log('C none'); } catch (e) { console.log('C ' + String(e.message || e).slice(0, 200)); }
var e1 = await page.locator('#enter').fill('a', {commit: 'enter'});
var e2 = await page.locator('#blur').nth(0).fill('b', {commit: 'blur'});
var e3 = await page.locator('#change').fill('c', {commit: 'change'});
console.log('D ' + JSON.stringify({commits: await page.evaluate(() => window.commits), ok: [e1.committed, e2.committed, e3.committed]}));
console.log('P ' + (await page.evaluate(() => document.querySelectorAll('[data-ux-pick]').length)));`;

test(
  "indexed fill uses the verified path, picks the on-screen copy and commits",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-fill-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const site = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(PAGE);
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-fill-chrome-"));
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
      const script = SCRIPT.replace("URL", JSON.stringify(url));
      const result = await run(process.execPath, [cli, "repl", "--session", "fill", script], {
        env,
      });
      const out = result.stdout + result.stderr;
      const line = (tag) =>
        out
          .split("\n")
          .find((text) => text.startsWith(tag + " "))
          ?.slice(2);
      const a = JSON.parse(line("A") ?? "null");
      assert.equal(a?.value, "frieren", out);
      assert.equal(a.model, "frieren", out);
      assert.equal(a.committed, true, out);
      assert.ok(["keys", "insertText", "paste", "native-setter"].includes(a.via), out);
      assert.deepEqual(JSON.parse(line("B") ?? "null"), { visible: "found", hidden: "" }, out);
      assert.match(line("C") ?? "", /TARGET_HIDDEN/, out);
      assert.doesNotMatch(line("C") ?? "", />=\s*0|too_small/, out);
      assert.deepEqual(
        JSON.parse(line("D") ?? "null"),
        { commits: { enter: 1, blur: 1, change: 1 }, ok: [true, true, true] },
        out,
      );
      assert.equal(line("P"), "0", out);
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
}

function nativeBootstrap(env) {
  return new Promise((resolveReply, reject) => {
    const host = spawn(
      process.execPath,
      [cli, "chrome-extension://dmlgohfphkbenjopdphcojgjeidlmajj/"],
      {
        env,
      },
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
    const callId = ++id;
    socket.send(JSON.stringify({ id: callId, method, params }));
    return new Promise((done) => waiting.set(callId, done));
  };
}

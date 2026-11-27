// Real Chrome: a goto/reload that never commits is stopped and names the document still
// showing; a screenshot that straddles a layout change is retried once; a click waits for a
// control that appears while the page is still hydrating.
// Run alone, from browser/: node --test test/nav-reliability.e2e.test.mjs
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

const homeHtml = `<!doctype html><title>Home</title><body>HOME
<div id="marker" style="width:80px;height:40px">mark</div>
<script>window.walks = 0;</script>`;
const hungHtml = `<!doctype html><title>Hung</title><body>HUNG-PAGE`;
const stickyHtml = `<!doctype html><title>Sticky</title><body>STICKY-PAGE`;
const replacedHtml = `<!doctype html><title>Replaced</title><body>REPLACED-PAGE`;

test(
  "a stalled navigation is stopped, a straddling snapshot is retried, and a late control is clicked",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-nav-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const hung = [];
    const stickyHeld = [];
    let stickyHits = 0;
    const site = createServer((request, response) => {
      request.on("error", () => {});
      response.on("error", () => {});
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "text/html");
      if (request.url === "/hang") {
        hung.push(response);
        setTimeout(() => {
          if (!response.writableEnded) response.end(hungHtml);
        }, 1600);
        return;
      }
      if (request.url === "/sticky") {
        stickyHits += 1;
        if (stickyHits === 1) response.end(stickyHtml);
        else {
          stickyHeld.push(response);
          setTimeout(() => {
            if (!response.writableEnded) response.end(replacedHtml);
          }, 1600);
        }
        return;
      }
      response.end(homeHtml);
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${site.address().port}`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-nav-chrome-"));
    let chrome;
    try {
      await waitFor(async () => JSON.parse(await readFile(join(home, "bridge.json"), "utf8")));
      chrome = spawn(chromePath, chromeArgs(profile), { stdio: "ignore" });
      await connectExtension(profile, env);
      const result = await repl(env, cell(origin));
      const out = `${result.stdout}\n${result.stderr}`;
      const snap = readHit(out, "SNAP");
      assert.equal(snap.detail.status, "ok", out);
      assert.ok(snap.detail.walks >= 4, out);
      const hydrate = readHit(out, "HYDRATE");
      assert.equal(hydrate.detail.status, "ok", out);
      assert.equal(hydrate.detail.went, 1, out);
      const nav = readHit(out, "NAV");
      assert.match(nav.detail.status, /^ERR TIMEOUT:/, out);
      assert.match(nav.detail.status, /still shows/, out);
      assert.match(nav.detail.text, /HOME/, out);
      assert.equal(nav.detail.text.includes("HUNG-PAGE"), false, out);
      const reload = readHit(out, "RELOAD");
      assert.equal(reload.detail.status, "ok", out);
      assert.equal(reload.detail.landed?.data?.timedOut, true, out);
      assert.match(reload.detail.landed?.data?.note ?? "", /still showing/, out);
      assert.match(reload.detail.text, /STICKY-PAGE/, out);
      assert.equal(reload.detail.text.includes("REPLACED-PAGE"), false, out);
    } finally {
      chrome?.kill();
      bridge.kill();
      site.close();
      for (const response of [...hung, ...stickyHeld]) {
        if (!response.writableEnded) response.end("");
      }
      await sleep(300);
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
    }
  },
  180000,
);

function readHit(out, label) {
  const text = new RegExp(`${label} (ok|ERR .*) (\\{.*\\})`).exec(out);
  if (!text) return { status: "", detail: {} };
  return { status: text[1], detail: JSON.parse(text[2]) };
}

function cell(origin) {
  return `const page = await browser.openTab(${JSON.stringify(`${origin}/`)});
async function phase(label, run) {
  let status = "ok";
  let detail = {};
  try { detail = await run(); }
  catch (error) { status = "ERR " + String(error && error.message || error).replace(/\\n/g, " | "); }
  console.log(label + " " + status + " " + JSON.stringify(detail));
}
await phase("SNAP", async () => {
  await page.evaluate(() => {
    var orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      var box = orig.call(this);
      if (this.id !== "marker") return box;
      window.walks += 1;
      var extra = window.walks <= 2 ? 15 * window.walks : 40;
      return new DOMRect(box.x, box.y, box.width, box.height + extra);
    };
  });
  let status = "ok";
  try { await page.screenshot(); }
  catch (error) { status = "ERR " + String(error && error.message || error).replace(/\\n/g, " | "); }
  return { status, walks: await page.evaluate(() => window.walks) };
});
await phase("HYDRATE", async () => {
  await page.evaluate(() => {
    window.went = 0;
    var n = 0;
    var timer = setInterval(function () {
      n += 1;
      document.body.setAttribute("data-n", String(n));
      if (n < 24) return;
      clearInterval(timer);
      var button = document.createElement("button");
      button.id = "go";
      button.textContent = "Go";
      button.style.cssText = "width:140px;height:48px";
      button.onclick = function () { window.went = 1; };
      document.body.appendChild(button);
    }, 50);
  });
  let status = "ok";
  try { await page.locator("#go").click(); }
  catch (error) { status = "ERR " + String(error && error.message || error).replace(/\\n/g, " | "); }
  return { status, went: await page.evaluate(() => window.went) };
});
await phase("NAV", async () => {
  await page.goto(${JSON.stringify(`${origin}/`)});
  let status = "ok";
  let landed = null;
  try { landed = await page.goto(${JSON.stringify(`${origin}/hang`)}, { timeoutMs: 1200 }); }
  catch (error) { status = "ERR " + String(error && error.message || error).replace(/\\n/g, " | "); }
  await new Promise((done) => setTimeout(done, 2500));
  let text = "";
  try { text = await page.evaluate(() => document.body.innerText.slice(0, 80)); }
  catch (error) { text = "ERR " + String(error && error.message || error); }
  return { status, text, landed };
});
await phase("RELOAD", async () => {
  await page.goto(${JSON.stringify(`${origin}/sticky`)});
  let status = "ok";
  let landed = null;
  try { landed = await page.reload({ timeoutMs: 1200 }); }
  catch (error) { status = "ERR " + String(error && error.message || error).replace(/\\n/g, " | "); }
  await new Promise((done) => setTimeout(done, 2500));
  let text = "";
  try { text = await page.evaluate(() => document.body.innerText.slice(0, 80)); }
  catch (error) { text = "ERR " + String(error && error.message || error); }
  return { status, text, landed };
});`;
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
      [cli, "repl", "--session", "nav-reliability", "--timeout", "120000", code],
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

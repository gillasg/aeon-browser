// Real Chrome: aria-disabled is a hint, not a click block. A native disabled control still refuses.
// Run alone, from browser/: node --test test/aria-disabled.e2e.test.mjs
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

const pageHtml = `<!doctype html><title>Hints</title>
<button type="button" id="next" aria-disabled="true" style="width:120px;height:40px" onclick="hits.next++">Next</button>
<button type="button" id="save" disabled style="width:120px;height:40px" onclick="hits.save++">Save</button>
<div inert><button type="button" id="locked" style="width:120px;height:40px" onclick="hits.locked++">Locked</button></div>
<iframe name="inner" src="/frame" style="width:300px;height:80px"></iframe>
<script>var hits = {next:0, save:0, locked:0, frame:0, frameSave:0};</script>`;

const frameHtml = `<!doctype html><title>Inner</title>
<button type="button" id="frame-next" aria-disabled="true" style="width:120px;height:40px" onclick="parent.hits.frame++">Frame next</button>
<button type="button" id="frame-save" disabled style="width:120px;height:40px" onclick="parent.hits.frameSave++">Frame save</button>`;

test(
  "an aria-disabled button is clicked and a native disabled button still refuses",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-aria-disabled-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const site = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(request.url === "/frame" ? frameHtml : pageHtml);
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-aria-disabled-chrome-"));
    let chrome;
    try {
      await waitFor(async () => JSON.parse(await readFile(join(home, "bridge.json"), "utf8")));
      chrome = spawn(chromePath, chromeArgs(profile), { stdio: "ignore" });
      await connectExtension(profile, env);
      const result = await repl(env, cell(url));
      const out = `${result.stdout}\n${result.stderr}`;
      const view = JSON.parse(/VIEW (.*)/.exec(out)?.[1] ?? '""');
      assert.match(view, /button "Next"[^\n]*disabled=true/, out);
      assert.match(view, /button "Save"[^\n]*disabled=true/, out);
      const aria = readHit(out, "ARIA");
      assert.equal(aria.status, "ok", out);
      assert.equal(aria.hits.next, 1, out);
      const native = readHit(out, "NATIVE");
      assert.match(native.status, /TARGET_DISABLED/, out);
      assert.equal(native.hits.save, 0, out);
      const inert = readHit(out, "INERT");
      assert.match(inert.status, /TARGET_DISABLED/, out);
      assert.equal(inert.hits.locked, 0, out);
      const frame = readHit(out, "FRAME");
      assert.equal(frame.status, "ok", out);
      assert.equal(frame.hits.frame, 1, out);
      const frameNative = readHit(out, "FRAME_NATIVE");
      assert.match(frameNative.status, /TARGET_DISABLED/, out);
      assert.equal(frameNative.hits.frameSave, 0, out);
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

function readHit(out, label) {
  const text = new RegExp(`${label} (ok|ERR .*) (\\{.*\\})`).exec(out);
  if (!text) return { status: "", hits: {} };
  return { status: text[1], hits: JSON.parse(text[2]) };
}

function cell(url) {
  return `const page = await browser.openTab(${JSON.stringify(url)});
const view = String(await bu.state());
console.log("VIEW " + JSON.stringify(view));
async function hit(label, run) {
  let status = "ok";
  try { await run(); }
  catch (error) { status = "ERR " + String(error && error.message || error).split("\\n")[0]; }
  const hits = await page.evaluate(() => hits);
  console.log(label + " " + status + " " + JSON.stringify(hits));
}
await hit("ARIA", () => page.getByRole("button", {name: "Next"}).click());
await hit("NATIVE", () => page.getByRole("button", {name: "Save"}).click());
await hit("INERT", () => page.locator("#locked").click());
const frame = await page.frame("/frame");
await frame.evaluate(() => document.querySelector("#frame-next").textContent);
await hit("FRAME", () => frame.getByRole("button", {name: "Frame next"}).click());
await hit("FRAME_NATIVE", () => frame.locator("#frame-save").click());`;
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
      [cli, "repl", "--session", "aria-disabled", "--timeout", "90000", code],
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
  });
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

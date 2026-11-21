// Real Chrome: a click can name its button and the modifiers held across the move, press and release.
// Run alone, from browser/: node --test test/click-buttons.e2e.test.mjs
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

const pageHtml = `<!doctype html><title>Clicks</title>
<button type="button" id="box" style="width:200px;height:48px">Box</button>
<a id="link" href="/next" style="display:block;width:200px;height:48px">Next</a>
<script>
window.seen = [];
function note(event) {
  seen.push({type: event.type, button: event.button, buttons: event.buttons,
    alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey});
  if (event.button >= 3) sessionStorage.setItem("aeon-button", String(event.button));
}
for (const type of ["mousemove", "mousedown", "mouseup", "click", "auxclick", "dblclick", "contextmenu"])
  document.addEventListener(type, note, true);
</script>`;

test(
  "click sends the named button and held modifiers",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-click-buttons-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const site = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(request.url === "/next" ? "<title>Next</title>arrived" : pageHtml);
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-click-buttons-chrome-"));
    let chrome;
    try {
      await waitFor(async () => JSON.parse(await readFile(join(home, "bridge.json"), "utf8")));
      chrome = spawn(chromePath, chromeArgs(profile), { stdio: "ignore" });
      await connectExtension(profile, env);
      const result = await repl(env, cell(url));
      const out = `${result.stdout}\n${result.stderr}`;
      const left = readHit(out, "LEFT");
      assert.equal(left.status, "ok", out);
      assert.ok(
        ofType(left, "click").some((event) => event.button === 0 && !event.meta),
        out,
      );
      const right = readHit(out, "RIGHT");
      assert.equal(right.status, "ok", out);
      assert.ok(
        ofType(right, "contextmenu").some((event) => event.button === 2),
        out,
      );
      assert.ok(
        ofType(right, "mousedown").some((event) => event.button === 2),
        out,
      );
      const meta = readHit(out, "META");
      assert.equal(meta.status, "ok", out);
      assert.ok(
        ofType(meta, "click").some((event) => event.meta),
        out,
      );
      assert.ok(
        ofType(meta, "mousemove").some((event) => event.meta),
        out,
      );
      const middle = readHit(out, "MIDDLE");
      assert.equal(middle.status, "ok", out);
      assert.ok(
        ofType(middle, "auxclick").some((event) => event.button === 1),
        out,
      );
      const dbl = readHit(out, "DBL");
      assert.equal(dbl.status, "ok", out);
      assert.ok(
        ofType(dbl, "dblclick").some((event) => event.shift),
        out,
      );
      const tab = readHit(out, "TAB");
      assert.equal(tab.status, "ok", out);
      assert.ok(tab.hits.after > tab.hits.before, out);
      assert.equal(tab.hits.stayed, true, out);
      const back = readHit(out, "BACK");
      assert.equal(back.status, "ok", out);
      assert.ok(
        ofType(back, "mousedown").some((event) => event.button === 3) ||
          back.hits.stored === "3" ||
          String(back.hits.href || "").includes("#a"),
        out,
      );
      const forward = readHit(out, "FORWARD");
      assert.equal(forward.status, "ok", out);
      const backMoved = String(back.hits.href || "").includes("#a");
      assert.ok(
        ofType(forward, "mousedown").some((event) => event.button === 4) ||
          forward.hits.stored === "4" ||
          (backMoved && String(forward.hits.href || "").includes("#b")),
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

function ofType(hit, type) {
  return (hit.hits.events || []).filter((event) => event.type === type);
}

function readHit(out, label) {
  const text = new RegExp(`${label} (ok|ERR .*) (\\{.*\\})`).exec(out);
  if (!text) return { status: "", hits: {} };
  return { status: text[1], hits: JSON.parse(text[2]) };
}

function cell(url) {
  return `const page = await browser.openTab(${JSON.stringify(url)});
async function hit(label, run) {
  try {
    await page.evaluate(() => {
      if (typeof seen !== "undefined") seen.length = 0;
      sessionStorage.removeItem("aeon-button");
    });
  } catch { /* a back click may have left the document */ }
  let status = "ok";
  try { await run(); }
  catch (error) { status = "ERR " + String(error && error.message || error).replace(/\\n/g, " | "); }
  let hits = {events: [], stored: null};
  try {
    hits = await page.evaluate(() => ({
      events: typeof seen === "undefined" ? [] : seen.slice(),
      stored: sessionStorage.getItem("aeon-button"),
      href: location.href,
    }));
  } catch (error) {
    if (status === "ok") status = "ERR " + String(error && error.message || error).replace(/\\n/g, " | ");
  }
  console.log(label + " " + status + " " + JSON.stringify(hits));
}
await hit("LEFT", () => page.locator("#box").click());
await hit("RIGHT", () => page.locator("#box").click({button: "right"}));
await hit("META", () => page.click("#box", {modifiers: ["meta"]}));
const at = await page.locator("#box").boundingBox();
await hit("MIDDLE", () => page.clickAt(at.x + at.width / 2, at.y + at.height / 2, {button: "middle"}));
await hit("DBL", () => page.locator("#box").dblclick({modifiers: ["shift"]}));
await page.evaluate(() => { history.pushState({}, "", "#a"); history.pushState({}, "", "#b"); });
await hit("BACK", () => page.locator("#box").click({button: "back"}));
await hit("FORWARD", () => page.locator("#box").click({button: "forward"}));
// A new tab is Command-click on macOS; Control-click there opens the context menu instead.
const before = (await browser.tabs()).length;
let stayed = true;
try {
  await page.locator("#link").click({modifiers: [${JSON.stringify(process.platform === "darwin" ? "meta" : "control")}]});
  stayed = !(await page.evaluate(() => location.pathname)).endsWith("/next");
} catch (error) { stayed = false; }
let after = before;
for (let i = 0; i < 20 && after === before; i++) {
  await new Promise((done) => setTimeout(done, 100));
  after = (await browser.tabs()).length;
}
console.log("TAB ok " + JSON.stringify({before, after, stayed, events: []}));`;
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
      [cli, "repl", "--session", "click-buttons", "--timeout", "90000", code],
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
        clientInstanceId: "091b9308-1ee9-420e-b71f-a564a5a27711",
        browserRunId: "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f9",
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

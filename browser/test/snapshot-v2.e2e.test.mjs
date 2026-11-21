// Real-Chrome check for snapshot v2: twelve named rows stay separate, a pointer div is a clickable,
// and an unnamed or repeated control outside a named row carries a DOM hint.
// Run alone, from browser/: node --test test/snapshot-v2.e2e.test.mjs
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

test(
  "bu.state names each Edit row, includes a clickable, and hints an unnamed control",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-snapshot-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const rows = Array.from({ length: 12 }, (_, index) => {
      const order = 1180 + index;
      return `<tr><td>${order}</td><td>Item ${index + 1}</td><td><button>Edit</button></td></tr>`;
    }).join("");
    const site = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><title>Orders</title>
        <nav aria-label="Main"><a href="/home">Home</a></nav>
        <main><h1>Your orders</h1>
          <table><tbody>${rows}</tbody></table>
          <div id="track" style="cursor:pointer;display:inline-block;width:140px;height:32px">Track shipment</div>
          <button>Save</button>
          <button><svg width="16" height="16"><use href="#icon-trash"></use></svg></button>
          <button><img alt="" src="/icons/pencil.png"></button>
          <table><tbody><tr><td>Order 9</td><td><button>Delete</button></td></tr></tbody></table>
          <button data-testid="overflow-delete">Delete</button>
        </main>`);
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const siteUrl = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-snapshot-chrome-"));
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
      const shot = await run(
        process.execPath,
        [
          cli,
          "repl",
          "--session",
          "snapshot",
          `page = await browser.openTab(${JSON.stringify(siteUrl)});\nawait bu.state();`,
        ],
        { env },
      );
      const out = `${shot.stdout}\n${shot.stderr}`;
      assert.match(out, /row "1180 · Item 1"/, out);
      assert.match(out, /row "1191 · Item 12"/, out);
      assert.doesNotMatch(out, /x12/, out);
      const ids = [...out.matchAll(/\[(?:f\d+:)?e?\d+\] button "Edit"/g)].map((match) => match[0]);
      assert.equal(new Set(ids).size, 12, out);
      assert.match(out, /clickable "Track shipment"/, out);
      assert.match(out, /hint="icon:icon-trash"/, out);
      assert.match(out, /hint="img:pencil"/, out);
      assert.match(out, /button "Delete" hint="data-testid:overflow-delete"/, out);
      const lines = out.split("\n");
      assert.ok(
        lines.some((line) => /button "Delete"/.test(line) && !line.includes("hint=")),
        out,
      );
      assert.ok(!lines.some((line) => /button "Edit"/.test(line) && line.includes("hint=")), out);
      const save = lines.find((line) => /button "Save"/.test(line));
      assert.ok(save && !save.includes("hint="), out);
      assert.match(out, /row "Order 9 · Delete"/, out);
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

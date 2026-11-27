// Real Chrome: a near-miss locator names the closest control, a table prints its columns once,
// and a too-large non-JSON fetch is refused instead of returned cut.
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

const PAGE = `<title>Start</title><main>
<button onclick="document.title='saved'">Save changes</button>
<table aria-label="Orders"><thead><tr><th>Order</th><th>Item</th><th>Status</th><th>Total</th></tr></thead>
<tbody>${[1, 2, 3, 4, 5, 6]
  .map(
    (n) =>
      `<tr><td>#${n}</td><td>Cable ${n}</td><td>Shipped</td><td>USD ${n}.00</td><td><button>Return ${n}</button></td></tr>`,
  )
  .join("")}</tbody></table></main>`;

test(
  "near-miss locators name the closest control and tables print their columns once",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-wins-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const site = createServer((request, response) => {
      if (request.url === "/big") {
        response.setHeader("content-type", "text/plain");
        response.end("x".repeat(250000) + "END");
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(PAGE);
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-wins-chrome-"));
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
      const result = await run(
        process.execPath,
        [
          cli,
          "repl",
          "--session",
          "wins",
          `page = await browser.openTab(${JSON.stringify(url)});
           try { await page.getByRole('button', {name: 'Sav chnges'}).click({timeout: 1500}); console.log("CLICKED"); }
           catch (error) { console.log("MISS " + String(error.message).replace(/\\n/g, " ~ ")); }
           try { await page.fetchJson(${JSON.stringify(url + "big")}); console.log("CUT"); }
           catch (error) { console.log("BIG " + String(error.message).slice(0, 200)); }
           console.log("STATE " + JSON.stringify(String(await page.state())));`,
        ],
        { env, timeout: 90000 },
      );
      const out = result.stdout + result.stderr;
      if (process.env.SHOW_E2E) console.log(out);
      assert.match(out, /MISS .*TARGET_NOT_FOUND/, out);
      assert.match(out, /MISS .*button "Save changes"/, out);
      assert.match(out, /BIG TOO_LARGE: .*250003 characters/, out);
      assert.doesNotMatch(out, /CUT|CLICKED/, out);
      const state = JSON.parse(/STATE (.*)/.exec(out)[1]);
      assert.match(state, /columns: Order \| Item \| Status \| Total/, state);
      assert.match(state, /row "#3 \| Cable 3 \| Shipped \| USD 3.00"/, state);
      assert.match(state, /\[\d+\] button "Return 3"/, state);
      assert.equal(state.match(/Status/g).length, 1, state);
      const repeated = state.replace(
        /row "([^"]*)"/g,
        (_all, cells) =>
          `row "${cells
            .split(" | ")
            .map((cell, i) => `${["Order", "Item", "Status", "Total"][i]}: ${cell}`)
            .join(" | ")}"`,
      );
      assert.ok(state.length < repeated.length - 100, `${state.length} vs ${repeated.length}`);
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
  180000,
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

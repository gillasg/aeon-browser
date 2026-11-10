// One targeted real-Chrome check: a click receipt names the popup, dialog, download and requests
// the click caused.
// Run alone: node --test test/receipts.e2e.test.mjs
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
import { dataRoutes } from "./data-site.mjs";

const chromePath =
  process.env.CHROME_PATH ??
  resolve("../.slice0-audit/chrome-for-testing-154.0.8037.57/chrome-win64/chrome.exe");
const extension = resolve("apps/extension/build");
const cli = resolve("apps/bridge/dist/cli.js");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = promisify(execFile);

test(
  "a click receipt names the popup, dialog and download it caused, and a self-closing pop-up is a success",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-frame-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const site = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      if (request.url === "/save") {
        response.statusCode = 422;
        response.end("{}");
      } else if (request.url === "/popup") response.end("<title>Popup</title>popup");
      else if (request.url === "/closer")
        response.end(
          '<title>Closer</title><button id="done" onclick="window.close()">done</button>',
        );
      else if (request.url === "/file") {
        response.setHeader("content-disposition", "attachment; filename=receipt.txt");
        response.end("receipt");
      } else
        response.end(`<title>Receipt</title>
        <button id="all" onclick="window.open('/popup','_blank'); confirm('sure')">all</button>
        <button id="file" onclick="confirm('save it'); const a=document.createElement('a'); a.href='/file'; a.download='receipt.txt'; a.click()">file</button>
        <button id="none">none</button>
        <button id="signin" onclick="window.open('/closer','_blank')">signin</button>
        <button id="save" onclick="fetch('/save', {method: 'POST', body: '{}'})">save</button>`);
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const siteUrl = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-frame-chrome-"));
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
        run(process.execPath, [cli, "repl", "--session", "receipts", code], { env });
      const first = await cell(`page = await browser.openTab(${JSON.stringify(siteUrl)});
        const receipt = await page.click("#all");\n        await page.waitForTimeout(400);
        console.log("RECEIPT " + JSON.stringify(receipt.receipt || receipt));`);
      const receipt = JSON.parse(/RECEIPT (.*)/.exec(first.stdout)[1]);
      assert.equal(receipt.popups.length, 1, first.stdout);
      assert.equal(receipt.dialog.type, "confirm", first.stdout);
      assert.equal(receipt.dialog.message, "sure", first.stdout);
      assert.equal(receipt.dialog.accepted, true, first.stdout);
      // Chrome may drop a script-started download once window.open used the click's gesture, so the
      // download (after a dialog, like a "save it?" prompt) gets its own click.
      const filed = await cell(
        `const file = await page.click("#file"); console.log("FILE " + JSON.stringify(file.receipt || file));`,
      );
      const download = JSON.parse(/FILE (.*)/.exec(filed.stdout)[1]);
      assert.equal(download.dialog?.message, "save it", filed.stdout);
      assert.match(download.download?.filename ?? "", /receipt\.txt/, filed.stdout);
      assert.match(download.download?.url ?? "", /\/file/, filed.stdout);
      assert.doesNotMatch(JSON.stringify(receipt), /popup<\/title>|receipt<\/title>/i);
      const second = await cell(
        `const again = await page.click("#none"); console.log("SECOND " + JSON.stringify(again.receipt || again));`,
      );
      const empty = JSON.parse(/SECOND (.*)/.exec(second.stdout)[1]);
      assert.equal(empty.popups.length, 0, second.stdout);
      assert.equal(empty.dialog, undefined, second.stdout);
      assert.equal(empty.download, undefined, second.stdout);
      assert.equal(empty.requests, undefined, second.stdout);
      // A submit says whether the server took it.
      const third = await cell(
        `const saved = await page.click("#save"); console.log("THIRD " + JSON.stringify(saved.receipt || saved));`,
      );
      const saved = JSON.parse(/THIRD (.*)/.exec(third.stdout)[1]);
      assert.equal(saved.requests?.[0]?.method, "POST", third.stdout);
      assert.equal(saved.requests?.[0]?.status, 422, third.stdout);
      assert.match(first.stdout + first.stderr, /never used/);
      // A pop-up that closes itself after a click (a sign-in window finishing) is a success.
      const fourth =
        await cell(`const opened = await page.click("#signin"); await page.waitForTimeout(400);
        const popup = await bu.use(opened.receipt.popups[0].tabId);
        const closed = await popup.click("#done");
        console.log("FOURTH " + JSON.stringify({ outcome: closed.outcome, note: closed.note }));`);
      const closed = JSON.parse(/FOURTH (.*)/.exec(fourth.stdout)[1]);
      assert.equal(closed.outcome, "changed", fourth.stdout);
      assert.match(closed.note, /closed this tab itself/, fourth.stdout);
      // A page whose main thread never answers fails the read in bounded time, not with the cell.
      const fifth =
        await cell(`page = await bu.use((await browser.tabs()).find((t) => t.title === "Receipt").id); await page.evaluate(() => setTimeout(() => { const end = Date.now() + 60000; while (Date.now() < end) {} }, 0)).catch(() => undefined);
        const began = Date.now();
        const err = await page.evaluate(() => 1).then(() => "answered", (e) => String(e.message || e));
        console.log("FIFTH " + JSON.stringify({ err, ms: Date.now() - began }));`);
      const hung = JSON.parse(/FIFTH (.*)/.exec(fifth.stdout)[1]);
      assert.match(hung.err, /did not answer within/, fifth.stdout);
      assert.ok(hung.ms < 25000, fifth.stdout);
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

test(
  "a download after confirm is on the receipt 20 of 20 times, and a 2s submit shows its final status",
  {
    timeout: 300_000,
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-receipt-loop-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const site = createServer((request, response) => {
      if (request.url === "/slow") {
        request.resume();
        setTimeout(() => {
          response.statusCode = 201;
          response.setHeader("content-type", "application/json");
          response.end("{}");
        }, 2000);
        return;
      }
      response.setHeader("content-type", "text/html");
      if (request.url === "/file") {
        response.setHeader("content-disposition", "attachment; filename=receipt.txt");
        response.end("receipt");
        return;
      }
      response.end(`<title>Receipt loop</title>
        <button id="file" onclick="confirm('save it'); const a=document.createElement('a'); a.href='/file'; a.download='receipt.txt'; a.click()">file</button>
        <button id="slow" onclick="fetch('/slow', {method:'POST', body:'{}'})">slow</button>`);
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const siteUrl = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-receipt-loop-chrome-"));
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
        run(
          process.execPath,
          [cli, "repl", "--session", "receipts-loop", "--timeout", "180000", code],
          {
            env,
          },
        );
      const opened = await cell(`page = await browser.openTab(${JSON.stringify(siteUrl)});
        const names = [];
        for (let i = 0; i < 20; i++) {
          const file = await page.click("#file");
          names.push((file.receipt && file.receipt.download && file.receipt.download.filename) || "");
        }
        const slow = await page.click("#slow");
        const request = slow.receipt && slow.receipt.requests && slow.receipt.requests[0];
        console.log("LOOP " + JSON.stringify({ names, request }));`);
      const loop = JSON.parse(/LOOP (.*)/.exec(opened.stdout)[1]);
      assert.equal(loop.names.length, 20, opened.stdout);
      for (const name of loop.names) assert.match(name, /receipt\.txt/, opened.stdout);
      assert.equal(loop.request?.method, "POST", opened.stdout);
      assert.equal(loop.request?.status, 201, opened.stdout);
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
  const port = await waitFor(async () =>
    Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]),
  );
  const worker = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
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
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const browser = await connect(version.webSocketDebuggerUrl);
  await browser("Target.createTarget", { url: "about:blank" });
  await waitFor(async () => {
    const { stdout } = await run(process.execPath, [cli, "status"], { env });
    if (!/1 browser/.test(stdout)) throw new Error(stdout);
  }, 30000);
  return cdp;
}

function nativeBootstrap(env, message) {
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
      JSON.stringify(
        message ?? {
          kind: "native.bootstrap",
          protocolVersion: { major: 1, minor: 6 },
          clientInstanceId: "091b9308-1ee9-420e-b71f-a564a5a27701",
          browserRunId: "3ee7ba6e-5aad-4692-9e4e-fb4cff0964f8",
        },
      ),
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

// Six fixture pages, one per dialog-rule row plus page.dialog.expect.
// Real Chrome: node --test test/dialogs.e2e.test.mjs (not run by the implementer).
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
  resolve("../.slice0-audit/chrome-for-testing-154.0.8037.57/chrome-win64/chrome.exe");
const extension = resolve("apps/extension/build");
const cli = resolve("apps/bridge/dist/cli.js");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = promisify(execFile);

const pages = {
  "/alert": `<title>Alert</title>
    <button id="go" onclick="alert('hello alert'); document.title='alerted'">go</button>
    <script>setTimeout(() => { alert('later alert'); window.__later = true; }, 6500);</script>`,
  "/asked": `<title>Asked</title>
    <button id="prompt" onclick="document.title = String(prompt('name','ada'))">prompt</button>
    <button id="confirm" onclick="document.title = String(confirm('sure'))">confirm</button>`,
  "/unasked": `<title>Unasked</title>
    <script>setTimeout(() => { window.__answer = confirm('on its own'); window.__done = true; }, 6500);</script>`,
  "/leave": `<title>Leave</title><script>
    addEventListener('beforeunload', (event) => { event.preventDefault(); event.returnValue = 'leaving now'; });
    </script><p>form</p>`,
  "/stay": `<title>Stay</title><script>
    addEventListener('beforeunload', (event) => { event.preventDefault(); event.returnValue = 'stay here'; });
    </script><p>yours</p>`,
  "/next": `<title>Next</title>arrived`,
  "/expect": `<title>Expect</title>
    <button id="yes" onclick="document.title = String(confirm('sure'))">yes</button>
    <button id="ask" onclick="document.title = String(prompt('name','ada'))">ask</button>`,
};

async function checkAlert(cell, logged, origin) {
  const alerted =
    await cell(`const page = await browser.openTab(${JSON.stringify(origin + "/alert")});
    const hit = await page.click("#go");
    console.log("ALERT " + JSON.stringify(hit.receipt && hit.receipt.dialog));
    await page.waitForTimeout(8000);
    console.log("LATER " + JSON.stringify(await page.evaluate(() => window.__later === true)));`);
  const alert = logged(alerted.stdout, "ALERT");
  assert.equal(alert.type, "alert", alerted.stdout);
  assert.equal(alert.message, "hello alert", alerted.stdout);
  assert.equal(alert.accepted, true, alerted.stdout);
  assert.equal(logged(alerted.stdout, "LATER"), true, alerted.stdout);
  assert.doesNotMatch(alerted.stdout, /\[warn\]/);
}

async function checkAsked(cell, logged, origin) {
  const asked =
    await cell(`const page = await browser.openTab(${JSON.stringify(origin + "/asked")});
    const prompt = await page.click("#prompt");
    const promptTitle = await page.evaluate(() => document.title);
    const confirm = await page.click("#confirm");
    const confirmTitle = await page.evaluate(() => document.title);
    console.log("ASKED " + JSON.stringify({
      prompt: prompt.receipt && prompt.receipt.dialog,
      promptTitle, confirmTitle,
      confirm: confirm.receipt && confirm.receipt.dialog,
    }));`);
  const row = logged(asked.stdout, "ASKED");
  assert.equal(row.prompt.type, "prompt", asked.stdout);
  assert.equal(row.prompt.message, "name", asked.stdout);
  assert.equal(row.prompt.accepted, true, asked.stdout);
  assert.equal(row.promptTitle, "ada", asked.stdout);
  assert.equal(row.confirm.type, "confirm", asked.stdout);
  assert.equal(row.confirm.message, "sure", asked.stdout);
  assert.equal(row.confirm.accepted, true, asked.stdout);
  assert.equal(row.confirmTitle, "true", asked.stdout);
}

async function checkUnasked(cell, logged, origin) {
  const unasked =
    await cell(`const page = await browser.openTab(${JSON.stringify(origin + "/unasked")});
    await page.waitForTimeout(8000);
    const state = await page.evaluate(() => ({ done: window.__done === true, answer: window.__answer }));
    console.log("UNASKED " + JSON.stringify(state));`);
  const own = logged(unasked.stdout, "UNASKED");
  assert.equal(own.done, true, unasked.stdout);
  assert.equal(own.answer, false, unasked.stdout);
  assert.match(unasked.stdout, /\[warn\][\s\S]*on its own/);
  assert.match(unasked.stdout, /page\.dialog\.expect/);
}

async function checkLeave(cell, logged, origin) {
  const next = origin + "/next";
  const left = await cell(`const page = await browser.openTab(${JSON.stringify(origin + "/leave")});
    await page.navigate(${JSON.stringify(next)});
    console.log("LEAVE " + JSON.stringify(await page.evaluate(() => location.href)));`);
  assert.match(logged(left.stdout, "LEAVE"), /\/next$/, left.stdout);
}

async function checkStay(cell, logged, origin) {
  const next = origin + "/next";
  const stayed =
    await cell(`const page = await browser.openTab(${JSON.stringify(origin + "/stay")});
    await page.waitForTimeout(2000);
    const moved = await page.evaluate(() => { location.href = ${JSON.stringify(next)}; return location.href; }).catch((error) => String(error));
    const url = await page.evaluate(() => location.href);
    console.log("STAY " + JSON.stringify({ moved, url }));`);
  const stay = logged(stayed.stdout, "STAY");
  assert.match(stay.url, /\/stay$/, stayed.stdout);
  assert.match(stayed.stdout, /\[warn\]/);
  assert.match(stayed.stdout, /page\.dialog\.expect/);
}

async function checkExpect(cell, logged, origin) {
  const expected =
    await cell(`const page = await browser.openTab(${JSON.stringify(origin + "/expect")});
    await page.dialog.expect("dismiss");
    const no = await page.click("#yes");
    const dismissed = await page.evaluate(() => document.title);
    await page.dialog.expect("typed");
    const yes = await page.click("#ask");
    const typed = await page.evaluate(() => document.title);
    console.log("EXPECT " + JSON.stringify({
      dismissed, typed,
      accepted: no.receipt && no.receipt.dialog && no.receipt.dialog.accepted,
      prompt: yes.receipt && yes.receipt.dialog,
    }));`);
  const row = logged(expected.stdout, "EXPECT");
  assert.equal(row.dismissed, "false", expected.stdout);
  assert.equal(row.accepted, false, expected.stdout);
  assert.equal(row.typed, "typed", expected.stdout);
  assert.equal(row.prompt.type, "prompt", expected.stdout);
  assert.equal(row.prompt.accepted, true, expected.stdout);
  assert.doesNotMatch(expected.stdout, /\[warn\]/);
}

test(
  "dialogs follow the rule: alert, asked, unasked, leave, stay, and page.dialog.expect",
  {
    skip:
      !process.env.REQUIRE_E2E &&
      (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)),
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-dialog-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const site = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      response.end(pages[path] ?? "<title>Missing</title>");
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${site.address().port}`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-dialog-chrome-"));
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
        run(process.execPath, [cli, "repl", "--session", "dialogs", code], {
          env,
          timeout: 90_000,
        });
      const logged = (stdout, name) => JSON.parse(new RegExp(name + " (.*)").exec(stdout)[1]);

      await checkAlert(cell, logged, origin);
      await checkAsked(cell, logged, origin);
      await checkUnasked(cell, logged, origin);
      await checkLeave(cell, logged, origin);
      await checkStay(cell, logged, origin);
      await checkExpect(cell, logged, origin);
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

// What a page can see of Aeon when nothing is happening on it: no page globals, no overlay
// nodes, no marker attributes, no injected extension scripts. The active cursor may draw while
// the agent works; once it leaves, nothing of ours stays in the page's own world.
// Run alone: node --test test/stealth-idle.e2e.test.mjs
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
const aeonCursor = resolve("../apps/chrome-extension/native-dist/cursor-page.js");
const cli = resolve("apps/bridge/dist/cli.js");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = promisify(execFile);

const pageHtml = `<title>Quiet</title>
<main><h1>Nothing here</h1><p>A page with no agent on it.</p></main>
<button id="go" onclick="document.title='continued'">Go</button>`;

test(
  "a page is free of Aeon globals, overlays and markers whenever the agent is idle",
  { skip: !process.env.REQUIRE_E2E && !existsSync(chromePath) },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "bue-stealth-idle-"));
    const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
    const site = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(pageHtml);
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${site.address().port}/`;
    const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
    const profile = await mkdtemp(join(tmpdir(), "bue-stealth-idle-chrome-"));
    let chrome;
    try {
      await waitFor(async () => JSON.parse(await readFile(join(home, "bridge.json"), "utf8")));
      chrome = spawn(chromePath, chromeArgs(profile), { stdio: "ignore" });
      const port = await connectExtension(profile, env);

      // A tab Aeon never drove: nothing of ours in its world.
      assert.deepEqual(
        await tellOn(await untouchPage(port, url)),
        emptyTells(),
        "a fresh page carries Aeon",
      );

      // Aeon drives the page, then goes idle: the cursor leaves and the page is clean again.
      const result = await run(
        process.execPath,
        [cli, "repl", "--session", "stealth-idle", repl(url)],
        {
          env,
        },
      );
      assert.match(result.stdout, /\[ok\] click changed/, result.stdout + result.stderr);
      // The run ends when its executor goes away (the daemon closing a run, or the CLI's bridge
      // stopping): the engine releases the session and its cursors by itself. Nothing in the test
      // touches the page's DOM.
      bridge.kill();
      const idlePage = await attachPage(port, url);
      const idleTells = await waitFor(async () => {
        const tells = await tellOn(idlePage);
        const cursors = await evalValue(
          idlePage,
          "[...document.documentElement.children].filter((n) => n.__cursorSurface).length",
        );
        if (tells.overlays.length || tells.markers.length || cursors)
          throw new Error("cursor still there");
        return tells;
      }, 8000);
      assert.deepEqual(idleTells, emptyTells(), "the driven page kept something of Aeon");

      // The cursor is an injected function, not a page listener: a page cannot paint it by
      // dispatching the old event, and the script leaves no listener or global behind.
      await assertNoPagePaint(await attachPage(port, url));
    } finally {
      chrome?.kill();
      bridge.kill();
      site.close();
      await sleep(200);
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
    }
  },
  60000,
);

async function assertNoPagePaint(page) {
  const cursorScript = await readFile(aeonCursor, "utf8");
  assert.equal(
    cursorScript.includes("aeon:cursor:paint"),
    false,
    "the built cursor listens for a page event",
  );
  const painted = await evalValue(
    page,
    `${cursorScript}\nwindow.dispatchEvent(new CustomEvent("aeon:cursor:paint", { detail: ${JSON.stringify(
      {
        update: { x: 20, y: 30, summon: true, place: true },
        css: "",
        mark: { path: "M1.2 1.2 L20 10 L8 20 Z", width: 22, height: 20, viewBox: "0 0 25 23" },
      },
    )} })); true`,
  );
  assert.equal(painted, true);
  assert.equal(
    await evalValue(
      page,
      "!![...document.documentElement.children].find((n) => n.__cursorSurface)",
    ),
    false,
    "a page event painted Aeon's cursor",
  );
  assert.deepEqual(await evalValue(page, globalsOnly), [], "the cursor left a page global");
  assert.deepEqual(await tellOn(page), emptyTells(), "a page event left marks on an idle page");
}

function repl(url) {
  return `page = await browser.openTab(${JSON.stringify(url)});
    await page.click('text=Go');
    await page.waitForTimeout(500);`;
}

const globalsOnly = `Object.getOwnPropertyNames(window).filter((name) => /^(__aeon|__browserkit|browserkit-)/.test(name))`;

// The one list of what an idle page must not carry, kept as source for Runtime.evaluate.
const tellsFn = `() => ({
  globals: ${globalsOnly},
  symbols: Object.getOwnPropertySymbols(window).map((key) => Symbol.keyFor(key) || String(key)).filter((name) => /aeon|browserkit/i.test(name)),
  overlays: [...document.querySelectorAll('[id^="aeon-"],[id^="browserkit-"],[data-aeon-overlay],[data-browserkit-overlay]')].map((node) => node.id ? "#" + node.id : node.tagName.toLowerCase()),
  markers: [...document.querySelectorAll("*")].flatMap((node) => [...node.attributes].map((attr) => attr.name)).filter((name) => /aeon|browserkit/i.test(name)),
  rootMarkers: [...document.documentElement.attributes, ...(document.body ? [...document.body.attributes] : [])].map((attr) => attr.name).filter((name) => /aeon|browserkit/i.test(name)),
  scripts: [...document.querySelectorAll("script[src]")].map((node) => node.src).filter((src) => /^chrome-extension:/.test(src)),
  styles: [...document.querySelectorAll("style")].map((node) => node.textContent || "").filter((text) => /aeon|browserkit/i.test(text))
})`;

function emptyTells() {
  return {
    globals: [],
    symbols: [],
    overlays: [],
    markers: [],
    rootMarkers: [],
    scripts: [],
    styles: [],
  };
}

async function tellOn(page) {
  return evalValue(page, `(${tellsFn})()`);
}

async function evalValue(page, expression) {
  const result = await page.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.result?.exceptionDetails)
    throw new Error(
      result.result.exceptionDetails.exception?.description ?? "page evaluate failed",
    );
  return result.result.result.value;
}

/** A tab opened outside Aeon: no debugger, no cursor, nothing of the extension in it. */
async function untouchPage(port, url) {
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const browser = connect(version.webSocketDebuggerUrl);
  await browser.opened;
  const made = await browser.send("Target.createTarget", { url });
  const targetId = made.result.targetId;
  const page = await attachPage(port, undefined, targetId);
  await waitFor(async () => {
    if ((await evalValue(page, "document.readyState")) !== "complete")
      throw new Error("page not loaded");
  });
  return page;
}

/** The page target for a URL, or a target id opened outside Aeon. */
async function attachPage(port, url, targetId) {
  const target = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const found = targets.find(
      (item) =>
        item.type === "page" &&
        item.webSocketDebuggerUrl &&
        (targetId ? item.id === targetId : item.url === url),
    );
    if (!found) throw new Error("no page target yet");
    return found;
  });
  const page = connect(target.webSocketDebuggerUrl);
  await page.opened;
  // A target can exist while its document is still loading; reading page attributes then races
  // a null documentElement.
  await waitFor(async () => {
    if ((await evalValue(page, "document.readyState").catch(() => "")) !== "complete")
      throw new Error("page not loaded");
  });
  return page;
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
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    "about:blank",
  ];
}

async function connectExtension(profile, env) {
  const port = await chromePort(profile);
  const worker = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((item) => item.json());
    const found = targets.find((item) => item.url.endsWith("/service-worker.js"));
    if (!found) throw new Error("no worker yet");
    return found;
  }, 60000);
  const reply = await nativeBootstrap(env);
  const cdp = connect(worker.webSocketDebuggerUrl);
  await cdp.opened;
  await waitFor(async () => {
    const ready = await cdp.send("Runtime.evaluate", {
      expression: "typeof chrome?.runtime?.id",
      returnByValue: true,
    });
    if (ready.result?.result?.value !== "string") throw new Error("worker not ready");
  });
  await cdp.send("Runtime.evaluate", {
    expression: `chrome.runtime.sendNativeMessage = (_host, request, callback) => callback(${JSON.stringify(reply)});`,
  });
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((item) => item.json());
  const browser = connect(version.webSocketDebuggerUrl);
  await browser.opened;
  await browser.send("Target.createTarget", { url: "about:blank" });
  await waitFor(async () => {
    const { stdout } = await run(process.execPath, [cli, "status"], { env });
    if (!/1 browser/.test(stdout)) throw new Error(stdout);
  }, 30000);
  return port;
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
    if (message.id === undefined) return;
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  const opened = new Promise((done) => socket.once("open", done));
  return {
    opened,
    send: async (method, params = {}) => {
      await opened;
      const callId = ++id;
      socket.send(JSON.stringify({ id: callId, method, params }));
      return new Promise((done) => waiting.set(callId, done));
    },
  };
}

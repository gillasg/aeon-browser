// The real-Chrome rig the boost e2e tests share: an isolated bridge home, a headless Chrome for
// Testing with the built extension, and `cell(code)` running browser code through the bridge.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromePort } from "../../../test/helpers/chrome-port.mjs";

const browserRoot = fileURLToPath(new URL("../../../", import.meta.url));
const WebSocket = createRequire(join(browserRoot, "package.json"))("ws");
export const chromePath =
  process.env.CHROME_PATH ??
  join(browserRoot, "../.slice0-audit/chrome-for-testing-157.0.8103.78/chrome-win64/chrome.exe");
const extension = join(browserRoot, "apps/extension/build");
const cli = join(browserRoot, "apps/bridge/dist/cli.js");
export const EXT_ID = "dmlgohfphkbenjopdphcojgjeidlmajj";
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = promisify(execFile);
const J = JSON.stringify;

/** Skip locally when the browser or the builds are missing; CI always runs. */
export const skipE2e =
  !process.env.CI &&
  !process.env.REQUIRE_E2E &&
  (!existsSync(chromePath) || !existsSync(extension) || !existsSync(cli));

export async function boot() {
  const home = await mkdtemp(join(tmpdir(), "boost-e2e-home-"));
  const profile = await mkdtemp(join(tmpdir(), "boost-e2e-chrome-"));
  const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
  const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
  let chrome;
  const stop = async () => {
    chrome?.kill();
    bridge.kill();
    await sleep(300);
    for (const dir of [profile, home])
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => {},
      );
  };
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
    const browser = await connectExtension(profile, env);
    const cell = async (code) => {
      const { stdout } = await run(
        process.execPath,
        [cli, "repl", "--session", "boost-e2e", code],
        {
          env,
          timeout: 90_000,
          maxBuffer: 1 << 24,
        },
      );
      const match = /^R (.*)$/m.exec(stdout);
      assert.ok(match, stdout);
      return JSON.parse(match[1]);
    };
    return { browser, cell, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function connectExtension(profile, env) {
  const port = await chromePort(profile);
  const worker = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const found = targets.find((item) => item.url.endsWith("/service-worker.js"));
    if (!found) throw new Error("no worker yet");
    return found;
  }, 60000);
  const reply = await nativeBootstrap(env);
  const sw = connect(worker.webSocketDebuggerUrl);
  await waitFor(async () => {
    const ready = await sw("Runtime.evaluate", {
      expression: "typeof chrome?.runtime?.id",
      returnByValue: true,
    });
    if (ready.result?.result?.value !== "string") throw new Error("worker not ready");
  });
  await sw("Runtime.evaluate", {
    expression: `chrome.runtime.sendNativeMessage = (_host, _request, callback) => callback(${J(reply)});`,
  });
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const browser = connect(version.webSocketDebuggerUrl);
  await browser("Target.createTarget", { url: "about:blank" });
  await waitFor(async () => {
    const { stdout } = await run(process.execPath, [cli, "status"], { env });
    if (!/1 browser/.test(stdout)) throw new Error(stdout);
  }, 30000);
  return browser;
}

function nativeBootstrap(env) {
  return new Promise((resolveReply, reject) => {
    const host = spawn(process.execPath, [cli, `chrome-extension://${EXT_ID}/`], { env });
    const chunks = [];
    host.stdout.on("data", (chunk) => chunks.push(chunk));
    host.on("error", reject);
    host.on("close", () => {
      const buffer = Buffer.concat(chunks);
      resolveReply(JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString("utf8")));
    });
    const body = Buffer.from(
      J({
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

export async function waitFor(check, timeout = 15000) {
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
  return async (method, params = {}, sessionId) => {
    await opened;
    return new Promise((done) => {
      waiting.set(++id, done);
      socket.send(J({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  };
}

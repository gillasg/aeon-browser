// A real Chrome for Testing with the built extension, connected to a local bridge, plus a CDP
// connection to Chrome itself so a test can act as the user (real mouse and key input).
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { chromePort } from "./chrome-port.mjs";
import { seedDownloadDir } from "./download-dir.mjs";

export const chromePath =
  process.env.CHROME_PATH ??
  resolve("../.slice0-audit/chrome-for-testing-157.0.8103.78/chrome-win64/chrome.exe");
const extension = resolve("apps/extension/build");
const cli = resolve("apps/bridge/dist/cli.js");
const run = promisify(execFile);
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function missingChrome() {
  if (process.env.REQUIRE_E2E) return false;
  return !existsSync(chromePath) || !existsSync(extension) || !existsSync(cli)
    ? "Chrome for Testing or the built extension is missing"
    : false;
}

/** Starts bridge and Chrome; returns {repl, browser, port, stop}. */
export async function startBridgeChrome(name) {
  const home = await mkdtemp(join(tmpdir(), `bue-${name}-`));
  const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
  const bridge = spawn(process.execPath, [cli, "serve"], { env, stdio: "ignore" });
  const profile = await mkdtemp(join(tmpdir(), `bue-${name}-chrome-`));
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
    const downloads = await seedDownloadDir(profile);
    chrome = spawn(chromePath, chromeArgs(profile), { stdio: "ignore" });
    const { port, browser } = await connectExtension(profile, env);
    const repl = (code, timeout = 120000) => replIn(env, name, code, timeout);
    return { repl, browser, port, stop, env, cli, downloads };
  } catch (error) {
    await stop();
    throw error;
  }
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
    "--window-size=1280,900",
    ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
    "about:blank",
  ];
}

async function replIn(env, session, code, timeout) {
  try {
    return await run(
      process.execPath,
      [cli, "repl", "--session", session, "--timeout", String(timeout), code],
      { env, maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (error) {
    return { stdout: error.stdout ?? "", stderr: `${error.stderr ?? ""}\n${error.message ?? ""}` };
  }
}

/** The JSON a cell printed after `label `, or undefined. */
export function readLine(out, label) {
  const line = new RegExp(`^${label} (\\{.*\\})$`, "m").exec(out);
  return line ? JSON.parse(line[1]) : undefined;
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
  return { port, browser };
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

export async function waitFor(check, timeout = 15000) {
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

/** A CDP connection: call(method, params, sessionId?) returns the raw reply. */
export function connect(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  const opened = new Promise((done) => socket.once("open", done));
  const call = async (method, params = {}, sessionId) => {
    await opened;
    const callId = ++id;
    socket.send(
      JSON.stringify({ id: callId, method, params, ...(sessionId ? { sessionId } : {}) }),
    );
    return new Promise((done) => waiting.set(callId, done));
  };
  call.close = () => socket.close();
  return call;
}

/** Attaches to the page whose URL starts with `prefix`; returns send(method, params). */
export async function attachPage(browser, prefix) {
  const page = await waitFor(async () => {
    const { result } = await browser("Target.getTargets");
    const found = result.targetInfos.find((t) => t.type === "page" && t.url.startsWith(prefix));
    if (!found) throw new Error("no page yet");
    return found;
  }, 30000);
  const attached = await browser("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  });
  const sessionId = attached.result.sessionId;
  return async (method, params = {}) => {
    const reply = await browser(method, params, sessionId);
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply.result;
  };
}

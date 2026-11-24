// Launches one real Chrome for a whole conformance sweep and connects Aeon's real engine to it:
// the built bridge, the built extension and a browser_code session per scenario. Ground truth that
// does not come through the engine (the real tab list) is read straight from Chrome's own CDP.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

const here = fileURLToPath(new URL(".", import.meta.url));
const browserRoot = resolve(here, "../../../..");
const repoRoot = resolve(browserRoot, "..");
export const extensionDir = join(browserRoot, "apps/extension/build");
export const bridgeCli = join(browserRoot, "apps/bridge/dist/cli.js");
const CFT = "chrome-for-testing-157.0.8103.78";
const CFT_BINARIES = {
  linux: "chrome-linux64/chrome",
  darwin: "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  win32: "chrome-win64/chrome.exe",
};

/** CHROME_PATH first, then the pinned Chrome for Testing the CI lane caches in the repo. */
export function findChrome() {
  if (process.env.CHROME_PATH)
    return existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : undefined;
  const pinned = join(repoRoot, ".slice0-audit", CFT, CFT_BINARIES[process.platform] ?? "");
  return existsSync(pinned) ? pinned : undefined;
}

/** Why the sweep cannot run here, or undefined when it can. */
export function missingPrerequisite() {
  if (!findChrome()) return "no Chrome: set CHROME_PATH or install Chrome for Testing 157";
  if (!existsSync(extensionDir)) return "the extension is not built (pnpm build:browser)";
  if (!existsSync(bridgeCli)) return "the bridge is not built (pnpm build:browser)";
  return undefined;
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** Polls `check` every 100 ms until it returns without throwing, or rethrows its last error. */
export async function poll(check, within = 15_000) {
  const deadline = Date.now() + within;
  let last;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      last = error;
    }
    if (Date.now() >= deadline) throw last ?? new Error("timed out");
    await pause(100);
  }
}

/** A minimal CDP client over one WebSocket. */
function cdpSocket(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    const done = waiting.get(message.id);
    if (!done) return;
    waiting.delete(message.id);
    done(message);
  });
  const opened = new Promise((done, fail) => {
    socket.once("open", done);
    socket.once("error", fail);
  });
  const send = async (method, params = {}) => {
    await opened;
    const callId = ++id;
    socket.send(JSON.stringify({ id: callId, method, params }));
    const reply = await new Promise((done) => waiting.set(callId, done));
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply.result;
  };
  return { send, close: () => socket.close() };
}

async function devtoolsPort(profile) {
  return poll(async () => {
    const port = Number(
      (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0],
    );
    if (!Number.isInteger(port) || port <= 0) throw new Error("no DevTools port yet");
    return port;
  }, 60_000);
}

/** The native host's bootstrap reply, which the extension would normally get from Chrome. */
function nativeBootstrap(env) {
  return new Promise((done, fail) => {
    const host = spawn(
      process.execPath,
      [bridgeCli, "chrome-extension://dmlgohfphkbenjopdphcojgjeidlmajj/"],
      { env },
    );
    const chunks = [];
    host.stdout.on("data", (chunk) => chunks.push(chunk));
    host.on("error", fail);
    host.on("close", () => {
      const buffer = Buffer.concat(chunks);
      done(JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString("utf8")));
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

/**
 * Starts the bridge and Chrome, connects the extension, and returns the sweep's handle:
 * `run(code, session)` runs one browser_code cell, `tabs()` is Chrome's own page list.
 */
export async function launchHarness() {
  const chromePath = findChrome();
  const home = await mkdtemp(join(tmpdir(), "aeon-conformance-"));
  const profile = join(home, "chrome-profile");
  const env = { ...process.env, BROWSERKIT_HOME: home, SITE_TO_API_HOME: join(home, "s2a") };
  // The policy scenario navigates to a site the user blocked; the rule is set before the bridge starts.
  await new Promise((done, fail) => {
    const block = spawn(process.execPath, [bridgeCli, "block", "blocked.test"], {
      env,
      stdio: "ignore",
    });
    block.on("error", fail);
    block.on("close", (code) =>
      code === 0 ? done() : fail(new Error(`browserkit block exited ${code}`)),
    );
  });
  const bridge = spawn(process.execPath, [bridgeCli, "serve"], { env, stdio: "ignore" });
  let chrome;
  let client;
  let browserCdp;
  const close = async () => {
    client?.close();
    browserCdp?.close();
    chrome?.kill();
    bridge.kill();
    await pause(300);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
      () => {},
    );
  };
  try {
    await poll(async () => JSON.parse(await readFile(join(home, "bridge.json"), "utf8")), 30_000);
    chrome = spawn(
      chromePath,
      [
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        `--load-extension=${extensionDir}`,
        `--disable-extensions-except=${extensionDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--headless=new",
        "--window-size=1280,800",
        ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
        ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    const port = await devtoolsPort(profile);
    const worker = await poll(async () => {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const found = targets.find((item) => item.url.endsWith("/service-worker.js"));
      if (!found) throw new Error("the extension worker has not started");
      return found;
    }, 60_000);
    const reply = await nativeBootstrap(env);
    const workerCdp = cdpSocket(worker.webSocketDebuggerUrl);
    await poll(async () => {
      const ready = await workerCdp.send("Runtime.evaluate", {
        expression: "typeof chrome?.runtime?.id",
        returnByValue: true,
      });
      if (ready.result?.value !== "string") throw new Error("worker not ready");
    });
    await workerCdp.send("Runtime.evaluate", {
      expression: `chrome.runtime.sendNativeMessage = (_host, request, callback) => callback(${JSON.stringify(reply)});`,
    });
    workerCdp.close();
    const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
    browserCdp = cdpSocket(version.webSocketDebuggerUrl);
    // Downloads stay inside the throwaway profile, where the download scenario checks the file.
    await browserCdp.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: join(profile, "Downloads"),
      eventsEnabled: false,
    });
    await browserCdp.send("Target.createTarget", { url: "about:blank" });
    // The bridge client reads BROWSERKIT_HOME when it connects, so set it before importing.
    process.env.BROWSERKIT_HOME = home;
    process.env.SITE_TO_API_HOME = env.SITE_TO_API_HOME;
    const { BridgeClient } = await import(
      pathToFileURL(join(browserRoot, "apps/bridge/dist/client.js")).href
    );
    client = await BridgeClient.connect({ launch: false });
    await poll(async () => {
      const status = await client.request("status");
      if (!(Number(status.browsers) >= 1)) throw new Error("no browser connected yet");
    }, 30_000);
    const versionInfo = version.Browser;
    const pages = async () =>
      (await browserCdp.send("Target.getTargets")).targetInfos.filter(
        (target) => target.type === "page",
      );
    // Chrome's startup pages and the extension welcome page: every later tab is a sweep tab.
    const baseTabs = await poll(async () => {
      const list = await pages();
      if (!list.some((target) => target.url.endsWith("/welcome.html")))
        throw new Error("welcome page not open yet");
      return list.length;
    }, 30_000).catch(async () => (await pages()).length);
    return {
      baseTabs,
      chromeVersion: versionInfo,
      downloads: join(profile, "Downloads"),
      home,
      /** Runs a browser_code cell; resolves to {value} or {error}, never throws. */
      run: (code, session, timeoutMs) =>
        client.request("run", { code, session, ...(timeoutMs ? { timeoutMs } : {}) }),
      /** Chrome's own top-level page targets: ground truth for tab counts. */
      tabs: pages,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { connectCdp, waitForDebugPort, stopChild } from "./browser-cdp-helper.mjs";
import assert from "node:assert/strict";

export async function browserFixture() {
  const folder = await mkdtemp(join(tmpdir(), "aeon-browser-fixture-"));
  const chromePath = resolve(
    ".slice0-audit/chrome-for-testing-154.0.8037.57/chrome-win64/chrome.exe",
  );
  const child = spawn(
    chromePath,
    [
      `--user-data-dir=${folder}`,
      "--headless=new",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "about:blank",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  let cdp;
  const oldChrome = globalThis.chrome;
  async function close() {
    globalThis.chrome = oldChrome;
    cdp?.socket.close();
    await stopChild(child);
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep));
    await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  try {
    const port = await waitForDebugPort(folder);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    cdp = await connectCdp(targets.find((item) => item.type === "page").webSocketDebuggerUrl);
    const commands = [];
    installChromeShim(cdp, commands);
    const api = await buildLayer(folder);
    await cdp.send("Page.enable");
    return {
      api,
      commands,
      close,
      debuggee: { tabId: 1 },
      folder,
      send: (method, params, sessionId) => cdp.send(method, params, sessionId),
      evaluate: (expression) => evaluate(cdp, expression),
      setPage: async (html) =>
        cdp.send("Page.setDocumentContent", {
          frameId: (await cdp.send("Page.getFrameTree")).frameTree.frame.id,
          html,
        }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
function installChromeShim(cdp, commands) {
  const event = { addListener() {}, removeListener() {} };
  const listeners = new Set();
  cdp.onEvent((method, params, sessionId) => {
    for (const listener of listeners)
      listener({ tabId: 1, ...(sessionId ? { sessionId } : {}) }, method, params);
  });
  const send = async (_debuggee, command, args) => {
    commands.push(command);
    return cdp.send(command, args, _debuggee.sessionId);
  };
  globalThis.chrome = {
    debugger: {
      sendCommand: send,
      attach: async () => {},
      detach: async () => {},
      onDetach: event,
      onEvent: {
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener),
      },
    },
    tabs: { onRemoved: event },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
  };
}
async function buildLayer(folder) {
  const outfile = join(folder, "browser-layer.mjs");
  await build({
    stdin: {
      contents: [
        "debugger",
        "input",
        "semantic",
        "dom",
        "screenshot",
        "readiness",
        "observation",
        "point",
        "session",
        "settle",
        "visible",
        "code",
        "text",
        "events",
        "frames",
        "files",
        "interaction",
        "frame-input",
        "downloads",
        "scroll",
        "scroll-container",
        "selector-state",
      ]
        .map((name) => `export * from './apps/chrome-extension/src/native-browser-${name}.ts';`)
        .join("\n"),
      resolveDir: resolve("."),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
  });
  return import(pathToFileURL(outfile).href);
}
async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

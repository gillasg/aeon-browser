import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { connectCdp, waitForDebugPort, stopChild } from "./browser-cdp-helper.mjs";
import assert from "node:assert/strict";

// Chrome for Testing 154. The CI job sets CHROME_PATH; the fallback matches that job's layout.
export function chromeForTestingPath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = resolve(".slice0-audit/chrome-for-testing-154.0.8037.57");
  if (process.platform === "darwin") {
    return join(
      root,
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    );
  }
  if (process.platform === "linux") return join(root, "chrome-linux64/chrome");
  return join(root, "chrome-win64/chrome.exe");
}

function chromeArguments(folder) {
  const args = [
    `--user-data-dir=${folder}`,
    "--headless=new",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
  ];
  // Linux CI runners forbid the user namespaces Chrome's sandbox needs.
  if (process.platform === "linux" && process.env.CI) args.push("--no-sandbox");
  args.push("about:blank");
  return args;
}

export async function browserFixture() {
  const folder = await mkdtemp(join(tmpdir(), "aeon-browser-fixture-"));
  // CHROME_PATH first: a worktree has no .slice0-audit folder of its own.
  const chromePath = chromeForTestingPath();
  const child = spawn(chromePath, chromeArguments(folder), { windowsHide: true, stdio: "ignore" });
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
    let page;
    for (let attempt = 0; !page && attempt < 50; attempt++) {
      if (attempt) await new Promise((done) => setTimeout(done, 100));
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    }
    assert.ok(page, "Chrome did not expose a page target");
    cdp = await connectCdp(page.webSocketDebuggerUrl);
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
    const source = { tabId: 1, ...(sessionId ? { sessionId } : {}) };
    // Chrome runs each listener on its own. One throw must not skip the dialog answer:
    // an open confirm() never returns on a headless page.
    for (const listener of listeners) {
      try {
        listener(source, method, params);
      } catch {
        /* The dialog handler still has to run. */
      }
    }
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
        "observation",
        "dom",
        "navigation",
        "session",
        "events",
        "frames",
        "downloads",
        "scroll",
      ]
        .map(
          (name) =>
            `export * from './apps/chrome-extension/node_modules/@browserkit/engine/src/native-browser-${name}.ts';`,
        )
        .concat(
          "export { installEngineListeners } from './apps/chrome-extension/node_modules/@browserkit/engine/src/native-engine-install.ts';",
          // The service worker loads this through the executor. This bundle has to load it too,
          // or confirm()/prompt() freeze the headless renderer until the file times out.
          "export { noteDialogAct } from './apps/chrome-extension/node_modules/@browserkit/engine/src/evidence/dialogs.ts';",
        )
        .join("\n"),
      resolveDir: resolve("."),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
  });
  const layer = await import(pathToFileURL(outfile).href);
  // Engine modules register their Chrome listeners when the worker installs them, as here. The
  // stand-in chrome has only the debugger and tab events these tests use; listeners for other
  // APIs fail to install, which these tests don't need.
  try {
    layer.installEngineListeners();
  } catch {
    // The debugger and tab listeners are installed; only the missing APIs' are not.
  }
  return layer;
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

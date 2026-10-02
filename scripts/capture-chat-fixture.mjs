import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const projectRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\//, ""));
const extensionDirectory = join(projectRoot, "apps", "chrome-extension", "dev-dist");
const screenshotDirectory = resolve(process.argv[2] ?? join(projectRoot, "artifacts", "slice-1"));
const contentViewport = { width: 1443, height: 811 };
const connectionGrant = process.env.PIPPIN_DEV_GRANT;
const chromeExecutable =
  process.env.PIPPIN_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
assert.ok(connectionGrant, "Set PIPPIN_DEV_GRANT to the one-run local development grant.");
await mkdir(screenshotDirectory, { recursive: true });

const profileDirectory = await mkdtemp(join(tmpdir(), "pippin-chat-capture-"));
assert.ok(resolve(profileDirectory).startsWith(`${resolve(tmpdir())}${sep}`));
const port = await availablePort();
const chrome = spawn(
  chromeExecutable,
  [
    `--user-data-dir=${profileDirectory}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--window-size=1600,900",
    "--window-position=-32000,-32000",
    "--force-device-scale-factor=1",
    "about:blank",
  ],
  { stdio: "ignore", windowsHide: true },
);
const chromeExit = new Promise((resolve) => chrome.once("exit", resolve));

let browser;
try {
  const version = await pollJson(`http://127.0.0.1:${port}/json/version`, (value) => value);
  browser = await connectCdp(version.webSocketDebuggerUrl);
  await browser.command("Target.setDiscoverTargets", { discover: true });
  const { id: extensionId } = await browser.command("Extensions.loadUnpacked", {
    path: extensionDirectory,
    enableInIncognito: false,
  });
  const optionsTarget = await createTarget(port, `chrome-extension://${extensionId}/options.html`);
  const options = await connectCdp(optionsTarget.webSocketDebuggerUrl);
  await configureViewport(options);
  await waitForPage(options, "document.readyState === 'complete'");
  await options.command("Runtime.evaluate", {
    expression: `(() => { const grant = ${JSON.stringify(connectionGrant)}; const input = document.getElementById('grant'); input.value = grant; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('connect-form').requestSubmit(); return true; })()`,
  });
  await waitForPage(options, "!document.getElementById('chat-launcher').hidden", 15_000);
  const launcherStatus = await evaluate(
    options,
    "document.getElementById('connection-status').textContent",
  );
  assert.match(launcherStatus, /local faux model.*no provider/i);
  await options.command("Runtime.evaluate", {
    expression: "document.getElementById('new-chat-form').requestSubmit()",
  });
  const chatTarget = await pollJson(
    `http://127.0.0.1:${port}/json/list`,
    (targets) =>
      targets.find((target) => target.type === "page" && target.url.includes("/chat.html?chatId=")),
    15_000,
  );
  const chat = await connectCdp(chatTarget.webSocketDebuggerUrl);
  await configureViewport(chat);
  await waitForPage(
    chat,
    "document.getElementById('connection-state').dataset.state === 'connected'",
    15_000,
  );
  await waitForPage(chat, "!document.getElementById('welcome').hidden", 5_000);
  const initialChat = await evaluate(
    chat,
    "({ title: document.title, headingCount: document.querySelectorAll('h1').length, badge: document.querySelector('.fixture-badge')?.innerText })",
  );
  assert.equal(
    initialChat.headingCount,
    0,
    "Chat title should stay in the native tab title rather than duplicate in-page.",
  );
  assert.match(initialChat.badge, /Development fixture/);
  assert.equal(await evaluate(chat, "document.getElementById('chat-sidebar').hidden"), true);
  await chat.command("Runtime.evaluate", {
    expression: "document.getElementById('sidebar-toggle').click()",
  });
  await waitForPage(
    chat,
    "!document.getElementById('chat-sidebar').hidden && document.getElementById('sidebar-chat-list').innerText.includes('New Chat')",
  );
  await saveScreenshot(chat, join(screenshotDirectory, "chat-sidebar-open.png"));
  await chat.command("Runtime.evaluate", {
    expression: "document.getElementById('sidebar-close').click()",
  });
  await waitForPage(chat, "document.getElementById('chat-sidebar').hidden");
  await saveScreenshot(chat, join(screenshotDirectory, "chat-empty.png"));

  await chat.command("Runtime.evaluate", {
    expression: `(() => { const input = document.getElementById('prompt'); input.value = 'List this local workspace, then summarize it.'; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('composer').requestSubmit(); return true; })()`,
  });
  await waitForPage(
    chat,
    "document.querySelector('.message-row.assistant .message-text')?.textContent?.includes('Local fixture response 1') && document.getElementById('run-indicator').hidden",
    20_000,
  );
  const completedChat = await evaluate(
    chat,
    "({ title: document.title, tool: document.querySelector('.activity-card > summary')?.innerText, trace: document.querySelector('.activity-preview')?.innerText, answer: [...document.querySelectorAll('.message-row.assistant .message-text')].map(node => node.innerText).join(' '), state: document.getElementById('connection-state').dataset.state })",
  );
  assert.equal(completedChat.state, "connected");
  assert.match(completedChat.tool.replace(/\s+/g, " "), /Worked for \d+s/);
  assert.match(completedChat.trace, /ls[\s\S]*empty directory/i);
  assert.match(completedChat.answer, /Local fixture response 1/);
  await saveScreenshot(chat, join(screenshotDirectory, "chat-fixture.png"));
  await chat.command("Runtime.evaluate", {
    expression: "document.querySelector('.activity-card > summary').click()",
  });
  await waitForPage(chat, "document.querySelector('.activity-card')?.open === true");
  await saveScreenshot(chat, join(screenshotDirectory, "chat-expanded-tool.png"));
  const dimensions = await evaluate(
    chat,
    "({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight })",
  );
  assert.deepEqual(dimensions, {
    ...contentViewport,
    scrollWidth: contentViewport.width,
    scrollHeight: contentViewport.height,
  });
  process.stdout.write(
    JSON.stringify({ screenshotDirectory, dimensions, initialChat, completedChat }, null, 2),
  );
  options.close();
  chat.close();
} finally {
  if (browser) {
    await browser.command("Browser.close").catch(() => undefined);
    browser.close();
  }
  await Promise.race([chromeExit, delay(4000)]);
  if (chrome.exitCode === null) chrome.kill();
  if (profileDirectory.startsWith(`${resolve(tmpdir())}${sep}`))
    await rm(profileDirectory, { recursive: true, force: true }).catch((error) => {
      process.stderr.write(
        `Temporary Chrome profile remains locked: ${profileDirectory} (${error.code ?? "cleanup error"}).\n`,
      );
    });
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) =>
    server.listen(0, "127.0.0.1", resolve).once("error", reject),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not allocate a Chrome debug port.");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function pollJson(url, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const value = await response.json();
        const match = predicate(value);
        if (match) return match;
      }
    } catch {
      /* Chrome is still starting. */
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

async function createTarget(debugPort, url) {
  const response = await fetch(
    `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" },
  );
  if (!response.ok)
    throw new Error(`Chrome could not open the development launcher (${response.status}).`);
  return response.json();
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Could not connect to the isolated Chrome page.")),
      { once: true },
    );
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const response = JSON.parse(String(event.data));
    const task = pending.get(response.id);
    if (!task) return;
    pending.delete(response.id);
    if (response.error) task.reject(new Error(response.error.message));
    else task.resolve(response.result);
  });
  return {
    command(method, params = {}) {
      const id = ++nextId;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      socket.close();
    },
  };
}

async function configureViewport(cdp) {
  await cdp.command("Page.enable");
  await cdp.command("Runtime.enable");
  await cdp.command("Emulation.setDeviceMetricsOverride", {
    ...contentViewport,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.command("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.text ?? "Page evaluation failed.");
  return result.result.value;
}

async function waitForPage(cdp, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, expression)) return;
    } catch {
      /* Navigation may still be in progress. */
    }
    await delay(100);
  }
  const diagnostics = await evaluate(
    cdp,
    "({ title: document.title, text: document.body.innerText.slice(0, 700), runHidden: document.getElementById('run-indicator')?.hidden, submitDisabled: document.getElementById('send')?.disabled, connection: document.getElementById('connection-state')?.innerText, subscription: document.getElementById('sync-notice')?.innerText })",
  ).catch(() => "unavailable");
  throw new Error(
    `Timed out waiting for the Chat page state: ${expression}; details=${JSON.stringify(diagnostics)}`,
  );
}

async function saveScreenshot(cdp, path) {
  const result = await cdp.command("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(path, Buffer.from(result.data, "base64"));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

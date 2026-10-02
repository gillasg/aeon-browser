import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { connectCdp, stopChild, waitForDebugPort, waitForExtension } from "./mv3-probe-helpers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chromePath = process.env.PIPPIN_CFT_PATH;
const extensionPath = join(root, "apps/chrome-extension/native-dist");
const extensionId = "npcdopokfkpfmepknhoecppgdgmkmihh";
const prompt = "Reply exactly: PIPPIN slice 3 Luna smoke OK.";
const profilePath = await mkdtemp(join(tmpdir(), "pippin-slice4-luna-"));
const chrome = spawn(
  chromePath,
  [
    `--user-data-dir=${profilePath}`,
    `--load-extension=${extensionPath}`,
    `--disable-extensions-except=${extensionPath}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-default-apps",
  ],
  { cwd: root, windowsHide: true, stdio: "ignore" },
);
let cdp;
let result;
let failure;

try {
  assert.ok(chromePath, "set PIPPIN_CFT_PATH to the Chrome for Testing executable");
  const port = await waitForDebugPort(profilePath);
  const browserInfo = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) =>
    response.json(),
  );
  cdp = await connectCdp(browserInfo.webSocketDebuggerUrl);
  assert.equal(await waitForExtension(cdp.send), extensionId);
  const home = await attachPage(cdp.send, `chrome-extension://${extensionId}/home.html`);
  await waitUntil(
    async () => {
      const status = await evaluate(
        cdp.send,
        home.sessionId,
        `({
      connected: document.getElementById("home-connection")?.textContent?.trim() === "Connected"
    })`,
      );
      return status.connected;
    },
    30_000,
    "native New Tab did not connect",
  );

  await cdp.send("Target.activateTarget", { targetId: home.targetId });
  await cdp.send("Page.enable", {}, home.sessionId);
  await cdp.send("Page.bringToFront", {}, home.sessionId);
  const focused = await evaluate(
    cdp.send,
    home.sessionId,
    `(() => {
      const input = document.getElementById("home-query");
      input.focus();
      return document.activeElement === input;
    })()`,
  );
  assert.equal(focused, true, "Ask field did not receive focus");
  await waitUntil(
    async () =>
      (await evaluate(
        cdp.send,
        home.sessionId,
        `document.getElementById("home-model-picker")?.firstElementChild?.textContent?.trim()`,
      )) === "GPT-6 Luna · openai-codex",
    30_000,
    "Pi model catalog did not load the configured fresh-session default",
  );
  await cdp.send("Input.insertText", { text: prompt }, home.sessionId);
  await waitUntil(
    async () =>
      (await evaluate(
        cdp.send,
        home.sessionId,
        `document.getElementById("home-query").value.length`,
      )) > 0,
    2000,
    "CDP did not type into the React-controlled Ask input",
  );
  await cdp.send(
    "Input.dispatchKeyEvent",
    { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    home.sessionId,
  );
  await cdp.send(
    "Input.dispatchKeyEvent",
    { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    home.sessionId,
  );

  const chatTarget = await waitForChatTarget(cdp.send, extensionId, 15_000);
  const chat =
    chatTarget.targetId === home.targetId
      ? home
      : {
          ...chatTarget,
          ...(await cdp.send("Target.attachToTarget", {
            targetId: chatTarget.targetId,
            flatten: true,
          })),
        };
  const submitted = await waitForChatCompletion(cdp.send, chat.sessionId, 150_000);
  assert.equal(submitted.userRows, 1, "Ask must submit exactly one first prompt");
  assert.ok(submitted.assistantRows > 0, "Pi did not produce an assistant response");

  await cdp.send("Page.reload", {}, chat.sessionId);
  result = await waitForLunaControls(cdp.send, chat.sessionId, 30_000);
  assert.equal(result.model, "openai-codex:gpt-6-luna");
  assert.equal(result.userRows, 1);
  assert.ok(result.assistantRows > 0);
  const screenshot = await cdp.send(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: true },
    chat.sessionId,
  );
  const evidencePath = join(root, "artifacts/slice3-native-ask-luna.png");
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, Buffer.from(screenshot.data, "base64"));
  process.stdout.write(
    JSON.stringify({
      browser: browserInfo.Browser,
      extensionConnected: true,
      model: result.model,
      userRows: result.userRows,
      assistantRows: result.assistantRows,
      completed: true,
      screenshot: evidencePath,
      promptOrResponseLogged: false,
    }) + "\n",
  );
} catch (error) {
  failure = error;
  const message = error instanceof Error ? error.message : "unknown smoke failure";
  process.stderr.write(`${message}\n`);
} finally {
  if (cdp?.socket.readyState === WebSocket.OPEN) {
    try {
      await cdp.send("Browser.close");
    } catch {
      /* Chrome may have exited. */
    }
    cdp.socket.close();
  }
  await stopChild(chrome);
  const tempRoot = resolve(tmpdir()) + sep;
  const resolvedProfile = resolve(profilePath);
  if (resolvedProfile.startsWith(tempRoot))
    await rm(resolvedProfile, { recursive: true, force: true });
  else {
    process.stderr.write("Refusing to remove profile outside temp.\n");
    process.exitCode = 1;
  }
}
if (failure) process.exitCode = 1;

async function attachPage(send, url) {
  const { targetId } = await send("Target.createTarget", { url });
  await delay(300);
  return { targetId, ...(await send("Target.attachToTarget", { targetId, flatten: true })) };
}

async function waitForChatTarget(send, id, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { targetInfos } = await send("Target.getTargets");
    const chat = targetInfos.find(
      (target) =>
        target.type === "page" &&
        target.url.startsWith(`chrome-extension://${id}/chat.html?chatId=`),
    );
    if (chat) return chat;
    await delay(250);
  }
  throw new Error("New Tab Ask did not navigate to the created Chat");
}

async function waitForChatCompletion(send, sessionId, timeout) {
  let state;
  await waitUntil(
    async () => {
      state = await evaluate(
        send,
        sessionId,
        `({
      connected: document.getElementById("connection-state")?.dataset.state === "connected",
      userRows: document.querySelectorAll(".message-row.user").length,
      assistantRows: document.querySelectorAll(".message-row.assistant").length,
      working: document.getElementById("run-indicator")?.hidden === false,
      error: Boolean(document.querySelector(".sync-notice[data-error='true']"))
    })`,
      );
      return state.connected && state.assistantRows > 0 && !state.working;
    },
    timeout,
    "Pi did not finish the Luna smoke prompt",
  );
  assert.equal(state.error, false, "Chat reported an error");
  return state;
}

async function waitForLunaControls(send, sessionId, timeout) {
  let state;
  await waitUntil(
    async () => {
      state = await evaluate(
        send,
        sessionId,
        `({
      connected: document.getElementById("connection-state")?.dataset.state === "connected",
      model: document.getElementById("model-picker")?.value ?? "",
      userRows: document.querySelectorAll(".message-row.user").length,
      assistantRows: document.querySelectorAll(".message-row.assistant").length,
      error: Boolean(document.querySelector(".sync-notice[data-error='true']"))
    })`,
      );
      return state.connected && state.model === "openai-codex:gpt-6-luna";
    },
    timeout,
    "reopened Chat did not report the Luna model",
  );
  assert.equal(state.error, false, "reopened Chat reported an error");
  return state;
}

async function evaluate(send, sessionId, expression) {
  const response = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (response.exceptionDetails) throw new Error("CFT page evaluation failed");
  return response.result.value;
}

async function waitUntil(predicate, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(250);
  }
  throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

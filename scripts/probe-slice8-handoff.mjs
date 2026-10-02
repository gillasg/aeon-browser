import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectCdp, stopChild, waitForDebugPort } from "./mv3-probe-helpers.mjs";
import { CftNativeHostSetup } from "./probe-browser-control-cft-helpers.mjs";
import { attachExtensionWorker, waitForText } from "./probe-slice8-e2e-helpers.mjs";
import { askFromNewTab } from "./probe-slice8-e2e-ask.mjs";
import {
  delay,
  installPageCommand,
  safeFailureMessage,
} from "./probe-browser-control-cft-browser.mjs";
import {
  installHandoffTelemetry,
  openExtensionHome,
  readHandoffStorage,
  readPageCheckpoint,
  readPiState,
  redactNotice,
  summarizeEvents,
} from "./probe-slice8-handoff-helpers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chromePath = join(
  root,
  ".slice0-audit",
  "chrome-for-testing-154.0.8037.57",
  "chrome-win64",
  "chrome.exe",
);
const nativeHostPath = join(root, "apps", "native-host", "dist", "pippin-native-host.exe");
const setup = new CftNativeHostSetup({
  root,
  chromePath: process.env.PIPPIN_CFT_CHROME_PATH ?? chromePath,
  nativeHostPath,
  daemonEntrypoint: join(root, "apps", "daemon", "dist", "main.js"),
  localAppData: process.env.LOCALAPPDATA,
});
const evidencePath = join(root, "artifacts", "slice8-handoff-e2e.json");
const evidence = {
  probe: "slice8-newtab-initial-submit-boundaries",
  checkpoints: [],
  promptOrCredentialLogged: false,
  newTabOverride: "Chrome 154 CFT automation uses a Chrome-created extension tab fallback",
};
const telemetry = [];
let browser;
let cdp;
let failure;
let stage = "native host setup";

try {
  await setup.prepare();
  stage = "disposable Chrome start";
  browser = spawn(
    setup.chromePath,
    [
      `--user-data-dir=${setup.profilePath}`,
      `--load-extension=${setup.extensionPath}`,
      `--disable-extensions-except=${setup.extensionPath}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-default-apps",
    ],
    { cwd: root, windowsHide: true, stdio: "ignore" },
  );
  const port = await waitForDebugPort(setup.profilePath);
  stage = "Chrome DevTools connection";
  const browserInfo = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) =>
    response.json(),
  );
  cdp = await connectCdp(browserInfo.webSocketDebuggerUrl);
  evidence.browser = browserInfo.Browser;
  const extensionId = setup.extensionId;
  stage = "extension worker attach";
  const worker = await attachExtensionWorker(cdp.send, extensionId);
  stage = "home tab create/attach";
  const home = await openExtensionHome(cdp.send, extensionId);
  stage = "handoff telemetry install";
  await installHandoffTelemetry(cdp.send, home.sessionId);
  cdp.socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data));
      if (
        message.method !== "Runtime.bindingCalled" ||
        message.params.name !== "__pippinHandoffProbe"
      )
        return;
      telemetry.push(JSON.parse(message.params.payload));
    } catch {
      /* Only bounded, prompt-free telemetry is collected. */
    }
  });
  await waitForText(
    cdp.send,
    home.sessionId,
    `document.getElementById("home-connection")?.textContent?.trim()`,
    "Connected",
    "Pippin New Tab did not connect",
    "home connected wait",
  );

  const askStartedAt = Date.now();
  stage = "Ask submit";
  await askFromNewTab(cdp.send, home.sessionId);
  stage = "handoff checkpoints";
  let chatSessionId = home.sessionId;
  let chatTargetId = home.targetId;
  let chatCommandInstalled = false;
  for (const checkpointSeconds of [5, 15, 30]) {
    const waitMs = askStartedAt + checkpointSeconds * 1000 - Date.now();
    if (waitMs > 0) await delay(waitMs);
    const targets = (await cdp.send("Target.getTargets")).targetInfos;
    const chatTarget = targets.find(
      (target) =>
        target.type === "page" &&
        target.url.startsWith(`chrome-extension://${extensionId}/chat.html?chatId=`),
    );
    if (chatTarget && chatTarget.targetId !== chatTargetId) {
      chatTargetId = chatTarget.targetId;
      chatSessionId = (
        await cdp.send("Target.attachToTarget", { targetId: chatTargetId, flatten: true })
      ).sessionId;
      await cdp.send("Runtime.enable", {}, chatSessionId);
      await installPageCommand(cdp.send, chatSessionId);
      chatCommandInstalled = true;
    }
    const page = await readPageCheckpoint(cdp.send, chatSessionId);
    if (page.route === "chat" && !chatCommandInstalled) {
      await installPageCommand(cdp.send, chatSessionId);
      chatCommandInstalled = true;
    }
    page.notice = redactNotice(page.notice);
    const chatId =
      page.chatId ??
      (chatTarget?.url ? new URL(chatTarget.url).searchParams.get("chatId") : undefined);
    const checkpoint = {
      seconds: checkpointSeconds,
      page,
      handoffStorage: await readHandoffStorage(cdp.send, worker.sessionId, chatId),
      events: summarizeEvents(telemetry),
      ...(checkpointSeconds >= 15 && chatCommandInstalled && chatId
        ? { pi: await readPiState(cdp.send, chatSessionId, chatId) }
        : {}),
    };
    evidence.checkpoints.push(checkpoint);
    const outcome = findFirstBoundary(checkpoint, checkpointSeconds);
    if (outcome) {
      evidence.status = outcome.status;
      evidence.boundary = outcome.boundary;
      evidence.code = outcome.code;
      break;
    }
  }
  evidence.status ??= "in-progress-at-30s";
  await persistEvidence();
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} catch (error) {
  failure = error;
  evidence.status = "probe-failed";
  evidence.failedStage = stage;
  evidence.error = safeFailureMessage(error);
  await persistEvidence();
  process.stderr.write(`${JSON.stringify(evidence)}\n`);
} finally {
  if (cdp?.socket.readyState === WebSocket.OPEN) {
    try {
      await cdp.send("Browser.close");
    } catch {
      /* The disposable browser may have exited. */
    }
    cdp.socket.close();
  }
  if (browser && browser.exitCode === null)
    await Promise.race([
      new Promise((resolveExit) => browser.once("exit", resolveExit)),
      delay(10_000),
    ]);
  if (browser && browser.exitCode === null) await stopChild(browser);
  await delay(300);
  await setup.cleanup();
  evidence.cleanup = "complete";
  await persistEvidence();
}

if (failure) process.exitCode = 1;

async function persistEvidence() {
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

function findFirstBoundary(checkpoint, checkpointSeconds) {
  return (
    failedOpenChat(checkpoint.events) ??
    failedPromptTake(checkpoint.events) ??
    failedPiSubmit(checkpoint.events) ??
    completedPrompt(checkpoint) ??
    stalledSubscription(checkpoint, checkpointSeconds) ??
    missingDaemonSubmit(checkpoint, checkpointSeconds) ??
    pendingPiResponse(checkpoint, checkpointSeconds) ??
    failedChatConnection(checkpoint, checkpointSeconds)
  );
}

function failedOpenChat(events) {
  const result = runtimeResult(events, "pippin.native.open-chat");
  return result && !result.ok
    ? { status: "failed", boundary: "New Tab to extension open-chat", code: result.code }
    : undefined;
}

function failedPromptTake(events) {
  const result = runtimeResult(events, "pippin.native.take-initial-submit");
  return result && !result.ok
    ? { status: "failed", boundary: "extension staged-prompt retrieval", code: result.code }
    : undefined;
}

function failedPiSubmit(events) {
  const result = events.find(
    (event) =>
      event.operation === "chat.submit" &&
      event.kind === "command.settled" &&
      event.state === "failed",
  );
  return result
    ? { status: "failed", boundary: "Pi prompt submission", code: result.code }
    : undefined;
}

function completedPrompt(checkpoint) {
  const settled = checkpoint.events.some(
    (event) => event.operation === "chat.submit" && event.kind === "command.settled",
  );
  if (!settled || checkpoint.page.assistantRows === 0) return undefined;
  return {
    status: checkpoint.page.answerMatched ? "passed" : "answer-mismatch",
    boundary: "New Tab Ask through transcript",
  };
}

function stalledSubscription(checkpoint, seconds) {
  if (
    seconds < 15 ||
    checkpoint.page.route !== "chat" ||
    checkpoint.page.connection !== "connected"
  )
    return undefined;
  const requested = checkpoint.events.some(
    (event) =>
      event.source === "extension" &&
      event.direction === "send" &&
      event.kind === "pippin.native.take-initial-submit",
  );
  if (requested) return undefined;
  const subscribed = checkpoint.events.some(
    (event) =>
      event.source === "daemon" &&
      event.direction === "receive" &&
      ["chat.snapshot", "chat.resumed"].includes(event.kind),
  );
  return {
    status: "failed",
    boundary: subscribed
      ? "Chat subscription response to initial-prompt retrieval"
      : "Chat event subscription",
  };
}

function missingDaemonSubmit(checkpoint, seconds) {
  if (seconds < 30) return undefined;
  const taken = runtimeResult(checkpoint.events, "pippin.native.take-initial-submit");
  const submitted = checkpoint.events.some(
    (event) =>
      event.source === "daemon" && event.direction === "send" && event.operation === "chat.submit",
  );
  return taken?.ok && !submitted
    ? { status: "failed", boundary: "extension handoff to daemon chat.submit" }
    : undefined;
}

function pendingPiResponse(checkpoint, seconds) {
  if (seconds < 30) return undefined;
  const started = checkpoint.events.some(
    (event) => event.operation === "chat.submit" && event.kind === "command.started",
  );
  return started
    ? { status: "in-progress", boundary: "Pi response after daemon accepted chat.submit" }
    : undefined;
}

function failedChatConnection(checkpoint, seconds) {
  return seconds >= 30 && checkpoint.page.connection !== "connected"
    ? { status: "failed", boundary: "Chat native connection" }
    : undefined;
}

function runtimeResult(events, kind) {
  return events.find(
    (event) => event.source === "extension" && event.direction === "receive" && event.kind === kind,
  );
}

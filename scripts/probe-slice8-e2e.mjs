import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { connectCdp, waitForDebugPort } from "./mv3-probe-helpers.mjs";
import { CftNativeHostSetup } from "./probe-browser-control-cft-helpers.mjs";
import {
  attachExtensionWorker,
  chromeFlags,
  openNewTab,
  waitForChatTarget,
  waitForText,
} from "./probe-slice8-e2e-helpers.mjs";
import { captureHomeAndAsk } from "./probe-slice8-e2e-home.mjs";
import { reconnectAndCapturePanel } from "./probe-slice8-e2e-reconnect.mjs";
import { exerciseBrowserControlListTrace } from "./probe-slice8-e2e-list-trace.mjs";
import { finalizeSlice8Result } from "./probe-slice8-e2e-result.mjs";
import {
  installPageCommand,
  safeFailureMessage,
  syntheticPage,
} from "./probe-browser-control-cft-browser.mjs";
import { cleanupProbe, classifyBoundary } from "./probe-slice8-ask-classification-helpers.mjs";
import {
  closeServer,
  compactHomeEvidence,
  failureCode,
  installTelemetryCollector,
  listenServer,
  waitForInitialAnswer,
} from "./probe-slice8-e2e-diagnostics.mjs";
import {
  captureFailureCheckpoint,
  exerciseBrowserControl,
  exerciseSidePanel,
} from "./probe-slice8-e2e-exercises.mjs";
import { installHandoffTelemetry } from "./probe-slice8-handoff-helpers.mjs";
import { exerciseNativeControls } from "./probe-slice8-native-controls.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chromePath =
  process.env.PIPPIN_CFT_CHROME_PATH ??
  join(root, ".slice0-audit", "chrome-for-testing-154.0.8037.57", "chrome-win64", "chrome.exe");
const nativeHostPath = join(root, "apps", "native-host", "dist", "pippin-native-host.exe");
const setup = new CftNativeHostSetup({
  root,
  chromePath,
  nativeHostPath,
  daemonEntrypoint: join(root, "apps", "daemon", "dist", "main.js"),
  localAppData: process.env.LOCALAPPDATA,
});
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const panelReconnectOnly = process.argv.includes("--panel-reconnect-only");
const startedAt = Date.now();
const evidencePath = join(root, "artifacts", "slice8-chat-sidepanel-e2e.json");
const pendingPath = join(root, "artifacts", "slice8-chat-sidepanel-e2e.pending.json");
const server = createServer((_request, response) => {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(syntheticPage());
});
const report = {
  probe: "slice8-newtab-chat-browser-panel-reconnect",
  runId,
  finalized: false,
  status: "running",
  stageHistory: [],
  homeChecks: [],
  checkpoints: [],
  promptOrCredentialLogged: false,
};
const telemetry = [];
const serverUrl = { value: "" };
let browser;
let cdp;
let worker;
let chatSessionId;
let panelSessionId;
let chatId;
let submittedAt;
let stage = "synthetic page server";
let pendingWrites = Promise.resolve();

await writePending(report);
try {
  await listenServer(server);
  serverUrl.value = `http://127.0.0.1:${server.address().port}/slice8`;
  await setStage("native host setup");
  await setup.prepare();
  await setStage("disposable Chrome start");
  browser = spawn(chromePath, chromeFlags(setup), {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
  });
  const port = await waitForDebugPort(setup.profilePath);
  await setStage("Chrome DevTools connection");
  const browserInfo = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  cdp = await connectCdp(browserInfo.webSocketDebuggerUrl);
  report.browser = browserInfo.Browser;
  await setStage("extension worker attach");
  worker = await attachExtensionWorker(cdp.send, setup.extensionId);
  await setStage("home tab create/attach");
  const { session: home, overrideActive } = await openNewTab(cdp.send, setup.extensionId);
  report.newTab = {
    overrideActive,
    route: overrideActive ? "chrome://newtab override" : "direct extension fallback",
  };
  installTelemetryCollector(cdp, telemetry);
  await installHandoffTelemetry(cdp.send, home.sessionId);
  await flushPendingWrites();
  const homeResult = await captureHomeAndAsk(
    cdp.send,
    home.sessionId,
    root,
    (value) => void setStage(value),
    (key, value) => recordHomeCheck(key, value),
  );
  await flushPendingWrites();
  submittedAt = homeResult.submittedAt;
  const initialSelection = homeResult.initialSelection;
  report.selection = {
    model: { provider: initialSelection.provider, id: initialSelection.id },
    effort: initialSelection.thinkingLevel,
  };
  report.screenshots = {
    home: homeResult.homeScreenshot,
    modelPicker: homeResult.modelPickerScreenshot,
    effortPicker: homeResult.effortPickerScreenshot,
  };
  report.askSubmittedAt = new Date(submittedAt).toISOString();
  await writePending(report);

  await setStage("Chat target wait");
  const chatTarget = await waitForChatTarget(cdp.send, setup.extensionId);
  chatId = new URL(chatTarget.url).searchParams.get("chatId");
  assert.ok(chatId, "New Tab did not open a Chat");
  const chat = await cdp.send("Target.attachToTarget", {
    targetId: chatTarget.targetId,
    flatten: true,
  });
  chatSessionId = chat.sessionId;
  await setStage("Chat connected wait");
  await waitForText(
    cdp.send,
    chatSessionId,
    `document.getElementById("connection-state")?.dataset.state`,
    "connected",
    "New Tab Chat did not connect",
  );
  await setStage("Chat page command install");
  await installPageCommand(cdp.send, chatSessionId);
  await writePending(report);

  await setStage("Pi initial response checkpoints");
  const initialCheckpoint = await waitForInitialAnswer({
    send: cdp.send,
    workerSessionId: worker.sessionId,
    sessionId: chatSessionId,
    chatId,
    serverUrl: serverUrl.value,
    events: telemetry,
    submittedAt,
    onCheckpoint: async (checkpoint) => {
      report.checkpoints.push({ boundary: "new_tab_ask", ...checkpoint });
      report.latestAskBoundary = checkpoint.ui?.answerMatched
        ? "assistant_answered"
        : classifyBoundary(checkpoint);
      await writePending(report);
    },
  });
  assert.equal(initialCheckpoint?.ui?.answerMatched, true, "Pi did not answer the New Tab prompt");
  assert.equal(initialCheckpoint.pi?.effectiveModel?.provider, initialSelection.provider);
  assert.equal(initialCheckpoint.pi?.effectiveModel?.id, initialSelection.id);
  assert.equal(initialCheckpoint.pi?.thinkingLevel, initialSelection.thinkingLevel);
  assert.equal(initialCheckpoint.pi?.active, false, "Pi was still generating the initial answer");
  assert.equal(initialCheckpoint.pi?.runState, "idle", "The initial Pi run did not settle");
  assert.equal(initialCheckpoint.ui?.running, false, "The Chat still showed an active initial run");
  report.completedBoundaries = ["new_tab_ask_to_assistant"];
  await writePending(report);

  const runBrowserControlExercise = panelReconnectOnly
    ? exerciseBrowserControlListTrace
    : exerciseBrowserControl;
  await runBrowserControlExercise({
    send: cdp.send,
    workerSessionId: worker.sessionId,
    sessionId: chatSessionId,
    chatId,
    events: telemetry,
    report,
    serverUrl: serverUrl.value,
    setStage,
    writePending,
  });
  const panel = await exerciseSidePanel({
    send: cdp.send,
    workerSessionId: worker.sessionId,
    extensionId: setup.extensionId,
    sessionId: chatSessionId,
    chatId,
    serverUrl: serverUrl.value,
    telemetry,
    report,
    onPanelAttached: (sessionId) => {
      panelSessionId = sessionId;
    },
    setStage,
    writePending,
  });
  panelSessionId = panel.sessionId;
  await setStage("native edit, tree and fork acceptance");
  report.nativeControls = await exerciseNativeControls({
    send: cdp.send,
    sessionId: chatSessionId,
    panelSessionId,
    chatId,
  });
  await writePending(report);
  const reconnect = await reconnectAndCapturePanel({
    send: cdp.send,
    chatSessionId,
    panelSessionId,
    chatId,
    selection: initialSelection,
    nativeHostPath,
    root,
    verifyExpectedErrors: !panelReconnectOnly,
  });
  await finalizeSlice8Result({
    report,
    reconnect,
    initialSelection,
    panelReconnectOnly,
    setStage,
    writePending,
  });
} catch (error) {
  report.status = "failed";
  report.failureStage = stage;
  report.failureCode = failureCode(stage);
  report.failureMessage = safeFailureMessage(error);
  await captureFailureCheckpoint({
    send: cdp?.send,
    workerSessionId: worker?.sessionId ?? "",
    sessionId: chatSessionId,
    panelSessionId,
    chatId,
    events: telemetry,
    report,
  });
  await writePending(report);
} finally {
  const serverClosed = await closeServer(server);
  report.cleanup = await cleanupProbe(cdp, browser, setup).catch(() => ({
    status: "incomplete",
    errors: ["cleanup_failed"],
  }));
  report.cleanup.serverClosed = serverClosed;
  if (!serverClosed) {
    report.cleanup.status = "incomplete";
    report.cleanup.errors = [...(report.cleanup.errors ?? []), "synthetic_server_close_failed"];
  }
  if (report.cleanup.status !== "complete" && report.status === "passed") {
    report.status = "cleanup_failed";
    report.failureStage = "cleanup";
  }
  report.finalized = true;
  report.finishedAt = new Date().toISOString();
  await flushPendingWrites().catch(() => {});
  await writeAtomicJson(evidencePath, report);
  await writeAtomicJson(join(root, "artifacts", "live-runs", `${runId}.json`), report);
}

process.stdout.write(
  `${JSON.stringify({
    finalized: report.finalized,
    status: report.status,
    outcome: report.outcome ?? null,
    failureStage: report.failureStage ?? null,
    cleanup: report.cleanup,
    evidencePath,
  })}\n`,
);
if (report.status !== "passed" || report.cleanup.status !== "complete") process.exitCode = 1;

function setStage(value) {
  stage = value;
  report.currentStage = value;
  report.stageHistory.push({ stage: value, elapsedMs: Date.now() - startedAt });
  return writePending(report);
}

function recordHomeCheck(key, value) {
  report.homeChecks.push(compactHomeEvidence(key, value));
}

async function flushPendingWrites() {
  await pendingWrites;
}

function writePending(value) {
  pendingWrites = pendingWrites.then(() => writeAtomicJson(pendingPath, value));
  return pendingWrites;
}

async function writeAtomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${runId}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

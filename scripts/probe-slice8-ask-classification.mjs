import { spawn } from "node:child_process";
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
import {
  classifyBoundary,
  cleanupProbe,
  isTerminalCheckpoint,
} from "./probe-slice8-ask-classification-helpers.mjs";
import {
  installHandoffTelemetry,
  readAskUiCheckpoint,
  readHandoffStorage,
  readPiState,
  summarizeEvents,
} from "./probe-slice8-handoff-helpers.mjs";
import { delay, installPageCommand } from "./probe-browser-control-cft-browser.mjs";

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
const artifactPath = join(root, "artifacts", `slice8-ask-response-classification-${runId}.json`);
const pendingPath = join(
  root,
  "artifacts",
  `slice8-ask-response-classification-${runId}.pending.json`,
);
const report = {
  probe: "slice8-ask-response-classification",
  runId,
  finalized: false,
  status: "running",
  checkpoints: [],
  promptOrCredentialLogged: false,
};
const telemetry = [];
let browser;
let cdp;
let worker;
let submittedAt;
let stage = "native host setup";

await writePending(report);
try {
  await setup.prepare();
  stage = "disposable Chrome start";
  browser = spawn(chromePath, chromeFlags(setup), {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
  });
  const port = await waitForDebugPort(setup.profilePath);
  stage = "Chrome DevTools connection";
  const browserInfo = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  cdp = await connectCdp(browserInfo.webSocketDebuggerUrl);
  report.browser = browserInfo.Browser;
  stage = "extension worker attach";
  worker = await attachExtensionWorker(cdp.send, setup.extensionId);
  stage = "home tab create/attach";
  const { session: home, overrideActive } = await openNewTab(cdp.send, setup.extensionId);
  report.newTab = {
    overrideActive,
    route: overrideActive ? "chrome://newtab override" : "direct extension fallback",
  };
  await installTelemetryCollector(cdp, home.sessionId, telemetry);
  const homeResult = await captureHomeAndAsk(
    cdp.send,
    home.sessionId,
    root,
    (value) => {
      stage = value;
    },
    () => {},
  );
  submittedAt = homeResult.submittedAt;
  report.selection = {
    model: {
      provider: homeResult.initialSelection.provider,
      id: homeResult.initialSelection.id,
    },
    effort: homeResult.initialSelection.thinkingLevel,
  };
  report.askSubmittedAt = new Date(submittedAt).toISOString();
  await writePending(report);
  await inspectChatResponse(cdp, worker, setup.extensionId, telemetry);
} catch {
  report.status = "probe_failed";
  report.failureStage = stage;
  report.failureCode = "PROBE_STAGE_FAILED";
  await writePending(report);
} finally {
  report.cleanup = await cleanupProbe(cdp, browser, setup);
  report.finalized = true;
  report.finishedAt = new Date().toISOString();
  await writeFinal(report, artifactPath);
}

const summary = {
  finalized: report.finalized,
  status: report.status,
  failureBoundary: report.failureBoundary ?? report.failureStage ?? null,
  cleanup: report.cleanup,
  artifactPath,
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
if (report.status !== "passed" || report.cleanup.status !== "complete") process.exitCode = 1;

async function installTelemetryCollector(connection, sessionId, events) {
  connection.socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data));
      if (
        message.method !== "Runtime.bindingCalled" ||
        message.params.name !== "__pippinHandoffProbe"
      )
        return;
      events.push(JSON.parse(message.params.payload));
    } catch {
      /* Only bounded telemetry is stored. */
    }
  });
  await installHandoffTelemetry(connection.send, sessionId);
}

async function inspectChatResponse(connection, nativeWorker, extensionId, events) {
  stage = "Chat target wait";
  const target = await waitForChatTarget(connection.send, extensionId);
  const chatId = new URL(target.url).searchParams.get("chatId");
  if (!chatId) throw new Error("CHAT_ID_MISSING");
  const chat = await connection.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  const chatSessionId = chat.sessionId;
  stage = "Chat connected wait";
  await waitForText(
    connection.send,
    chatSessionId,
    `document.getElementById("connection-state")?.dataset.state`,
    "connected",
    "New Tab Chat did not connect",
  );
  await installPageCommand(connection.send, chatSessionId);
  report.chat = { connected: true };
  await writePending(report);
  await sampleResponse(connection.send, nativeWorker, chatSessionId, chatId, events);
}

async function sampleResponse(send, nativeWorker, sessionId, targetChatId, events) {
  const checkpoints = [5, 15, 30, 60, 90, 120];
  for (const seconds of checkpoints) {
    const waitMs = submittedAt + seconds * 1000 - Date.now();
    if (waitMs > 0) await delay(waitMs);
    if (seconds < 120 && seconds * 1000 + submittedAt < Date.now() - 1000) continue;
    stage = `Ask response checkpoint ${seconds}s`;
    const checkpoint = await captureCheckpoint(send, nativeWorker, sessionId, targetChatId, events);
    checkpoint.scheduledSeconds = seconds;
    checkpoint.elapsedSeconds = Math.round((Date.now() - submittedAt) / 1000);
    report.checkpoints.push(checkpoint);
    await writePending(report);
    if (isTerminalCheckpoint(checkpoint)) break;
  }
  const latest = report.checkpoints.at(-1);
  if (latest?.ui?.answerMatched) {
    report.status = "passed";
    report.outcome = "assistant_answered";
  } else {
    report.status = "failed";
    report.failureBoundary = latest ? classifyBoundary(latest) : "no_checkpoint";
  }
}

async function captureCheckpoint(send, nativeWorker, sessionId, targetChatId, events) {
  const ui = await readAskUiCheckpoint(send, sessionId).catch(() => ({ readable: false }));
  const handoff = await readHandoffStorage(send, nativeWorker.sessionId, targetChatId);
  const pi = await readPiState(send, sessionId, targetChatId).catch(() => ({ readable: false }));
  return { ui, handoff, pi, events: summarizeEvents(events) };
}

async function writePending(value) {
  await mkdir(dirname(pendingPath), { recursive: true });
  await writeAtomicJson(pendingPath, value);
}

async function writeFinal(value, path) {
  await mkdir(dirname(path), { recursive: true });
  await writeAtomicJson(path, value);
}

async function writeAtomicJson(path, value) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

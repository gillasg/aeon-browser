import assert from "node:assert/strict";
import {
  attachSidePanel,
  chooseChatInPanel,
  openSidePanel,
  toolEvidenceSummary,
} from "./probe-slice8-e2e-helpers.mjs";
import { attachPage, pageValue, waitUntil } from "./probe-browser-control-cft-browser.mjs";
import { runBrowserProbeChat } from "./probe-browser-control-cft-chat.mjs";
import { classifyBoundary } from "./probe-slice8-ask-classification-helpers.mjs";
import { captureChatCheckpoint, capturePanelCheckpoint } from "./probe-slice8-e2e-diagnostics.mjs";
import { ensureBrowserErrorGeneration } from "./probe-slice8-e2e-browser-evidence.mjs";

export async function exerciseBrowserControl({
  send,
  workerSessionId,
  sessionId,
  chatId,
  events,
  report,
  serverUrl,
  setStage,
  writePending,
}) {
  await setStage("browser-control synthetic page attach");
  const borrowed = await attachPage(send, serverUrl);
  await send("Target.activateTarget", { targetId: borrowed.targetId });
  await setStage("browser-control two-turn task");
  const turns = await runBrowserProbeChat({
    send,
    sessionId,
    chatId,
    borrowedUrl: serverUrl,
    openedUrl: `${serverUrl}/opened`,
    onCommandSettled: async (checkpoint) => {
      report.browserControlTurns ??= [];
      report.browserControlTurns.push(checkpoint);
      await setStage(`browser-control turn ${checkpoint.turn} settled`);
      await writePending(report);
    },
  });
  await ensureBrowserErrorGeneration({
    send,
    workerSessionId,
    sessionId,
    chatId,
    events,
    borrowedUrl: serverUrl,
    report,
    setStage,
    writePending,
  });
  await completeBrowserControlChecks({
    send,
    workerSessionId,
    sessionId,
    chatId,
    events,
    borrowed,
    serverUrl,
    report,
    turns: turns.turns,
    setStage,
    writePending,
  });
}

async function completeBrowserControlChecks({
  send,
  workerSessionId,
  sessionId,
  chatId,
  events,
  borrowed,
  serverUrl,
  report,
  turns,
  setStage,
  writePending,
}) {
  report.browserControlFailuresVisible = await verifyFailureEvidence(
    send,
    sessionId,
    setStage,
    report,
    writePending,
  );
  const browserResult = await readBrowserResult(send, borrowed.sessionId, serverUrl, setStage);
  report.browserControlPage = browserResult;
  await writePending(report);
  assert.equal(browserResult.urlMatches, true);
  assert.equal(browserResult.marked, true);
  assert.equal(browserResult.inputMatched, true);
  const openedTargetObserved = await hasOpenedTarget(send, serverUrl, setStage);
  report.browserControlOpenedTargetObserved = openedTargetObserved;
  await writePending(report);
  assert.ok(openedTargetObserved);
  report.browserControl = browserControlEvidence({
    turns,
    browserResult,
    failures: report.browserControlFailuresVisible,
    events,
  });
  report.completedBoundaries.push("browser_control_synthetic_page");
  report.checkpoints.push({
    boundary: "browser_control",
    chat: await captureChatCheckpoint(send, workerSessionId, sessionId, chatId, events),
    browserControl: report.browserControl,
  });
  await writePending(report);
}

function browserControlEvidence({ turns, browserResult, failures, events }) {
  return {
    turnsCompleted: turns,
    originalTabPreserved: browserResult.urlMatches,
    targetMarked: browserResult.marked,
    inputMatched: browserResult.inputMatched,
    expectedOpenedTargetObserved: true,
    expectedFailuresVisible: failures,
    askSelectionRetained: Boolean(events.some((event) => event.operation === "chat.submit")),
  };
}

async function verifyFailureEvidence(send, sessionId, setStage, report, writePending) {
  await setStage("browser-control expected error evidence");
  let latest;
  try {
    await waitUntil(
      async () => {
        latest = await pageValue(send, sessionId, toolEvidenceSummary());
        return latest;
      },
      (summary) => summary.staleReference && summary.ambiguousTarget && summary.imagePreviewReady,
      30_000,
      "Browser error rows or the real screenshot thumbnail were not visible",
    );
  } finally {
    if (latest) {
      report.browserControlEvidence = latest;
      await writePending(report);
    }
  }
  return latest;
}

async function readBrowserResult(send, sessionId, serverUrl, setStage) {
  await setStage("browser-control original tab state");
  return pageValue(
    send,
    sessionId,
    `({urlMatches:${JSON.stringify(serverUrl)}===location.href, marked:document.documentElement.dataset.marked==="yes", inputMatched:document.getElementById("result")?.value==="PIPPIN_SLICE4_OK"})`,
  );
}

async function hasOpenedTarget(send, serverUrl, setStage) {
  await setStage("browser-control opened target");
  const targets = (await send("Target.getTargets")).targetInfos;
  return targets.some((target) => target.url === `${serverUrl}/opened`);
}

export async function exerciseSidePanel({
  send,
  workerSessionId,
  extensionId,
  sessionId,
  chatId,
  serverUrl,
  telemetry,
  report,
  onPanelAttached,
  setStage,
  writePending,
}) {
  await setStage("side-panel open");
  const borrowedSession = await attachSyntheticTab(send, serverUrl);
  report.sidePanelProgress = { syntheticTabMatched: true };
  await writePending(report);
  await send("Runtime.enable", {}, borrowedSession.sessionId);
  await setStage("side-panel Chrome tab ID lookup");
  const tabId = await readSyntheticTabId(send, sessionId, serverUrl);
  report.sidePanelProgress.tabIdAvailable = Number.isInteger(tabId);
  await writePending(report);
  assert.ok(Number.isInteger(tabId), "The synthetic tab has no Chrome tab ID");
  await openSidePanelInAvailableContext({
    send,
    workerSessionId,
    extensionPageSessionId: sessionId,
    tabId,
    report,
    setStage,
    writePending,
  });
  const panel = await attachSidePanelWithProgress(
    send,
    extensionId,
    report,
    onPanelAttached,
    setStage,
    writePending,
  );
  await selectAndConnectPanelChat(send, panel, chatId, setStage);
  const checkpoint = await capturePanelCheckpoint(send, panel.sessionId, chatId);
  assert.equal(checkpoint.connection, "connected");
  assert.equal(checkpoint.frameChatMatches, true);
  report.sidePanel = { connected: true, chatMatches: true, initialCheckpoint: checkpoint };
  report.sidePanel.openContext = report.sidePanelProgress.openContext;
  report.completedBoundaries.push("side_panel_connected");
  report.checkpoints.push({
    boundary: "side_panel_initial",
    fullChat: await captureChatCheckpoint(send, workerSessionId, sessionId, chatId, telemetry),
    panel: checkpoint,
  });
  await writePending(report);
  return panel;
}

async function attachSyntheticTab(send, serverUrl) {
  const targets = (await send("Target.getTargets")).targetInfos;
  const target = targets.find((item) => item.url === serverUrl);
  assert.ok(target, "The original synthetic browser tab is missing");
  return send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
}

async function recordSidePanelTargetScan(report, writePending, targetScan) {
  report.sidePanelProgress.targetScan = targetScan;
  await writePending(report);
}

async function attachSidePanelWithProgress(
  send,
  extensionId,
  report,
  onPanelAttached,
  setStage,
  writePending,
) {
  await setStage("side-panel extension page attach");
  const panel = await attachSidePanel(send, extensionId, (targetScan) =>
    recordSidePanelTargetScan(report, writePending, targetScan),
  );
  onPanelAttached(panel.sessionId);
  return panel;
}

async function selectAndConnectPanelChat(send, panel, chatId, setStage) {
  await setStage("side-panel Chat select/connect");
  await chooseChatInPanel(send, panel.sessionId, chatId);
  await waitUntil(
    () => capturePanelCheckpoint(send, panel.sessionId, chatId),
    (state) => state.connection === "connected" && state.frameChatMatches,
    30_000,
    "The selected side-panel Chat did not connect",
  );
}

function readSyntheticTabId(send, sessionId, serverUrl) {
  return pageValue(
    send,
    sessionId,
    `chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === ${JSON.stringify(serverUrl)})?.id)`,
  );
}

async function openSidePanelInAvailableContext({
  send,
  workerSessionId,
  extensionPageSessionId,
  tabId,
  report,
  setStage,
  writePending,
}) {
  await setStage("side-panel API open via service worker");
  try {
    await openSidePanel(send, workerSessionId, tabId);
    report.sidePanelProgress.openContext = "service_worker";
  } catch {
    report.sidePanelProgress.workerOpenFailed = true;
    await writePending(report);
    await setStage("side-panel API open via Chat extension page");
    await openSidePanel(send, extensionPageSessionId, tabId);
    report.sidePanelProgress.openContext = "chat_extension_page";
  }
  await writePending(report);
}

export async function captureFailureCheckpoint({
  send,
  workerSessionId,
  sessionId,
  panelSessionId,
  chatId,
  events,
  report,
}) {
  if (sessionId && chatId) {
    const failed = await captureChatCheckpoint(
      send,
      workerSessionId,
      sessionId,
      chatId,
      events,
    ).catch(() => ({ readable: false }));
    report.failureCheckpoint = failed;
    if (report.status !== "passed" && failed.pi?.readable !== false)
      report.failureBoundary = classifyBoundary(failed);
  }
  if (panelSessionId) {
    report.panelFailureCheckpoint = await capturePanelCheckpoint(
      send,
      panelSessionId,
      chatId,
    ).catch(() => ({ readable: false }));
  }
}

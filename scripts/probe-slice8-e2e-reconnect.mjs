import assert from "node:assert/strict";
import { join } from "node:path";
import {
  commandExpression,
  openSplitFallback,
  panelToolEvidenceSummary,
  stopDisposableSupervisor,
  waitForText,
  watchPanelConnection,
} from "./probe-slice8-e2e-helpers.mjs";
import { pageValue, waitUntil } from "./probe-browser-control-cft-browser.mjs";
import { captureScreenshot } from "./probe-slice8-e2e-screenshots.mjs";

export async function reconnectAndCapturePanel({
  send,
  chatSessionId,
  panelSessionId,
  chatId,
  selection,
  nativeHostPath,
  root,
  verifyExpectedErrors = true,
}) {
  const fullTranscript = await readTranscript(send, chatSessionId, false);
  assert.deepEqual(await readTranscript(send, panelSessionId, true), fullTranscript);
  await verifyPanelTitle(send, chatSessionId, panelSessionId);
  const splitFallback = await openSplitFallback(send, panelSessionId);
  assert.match(splitFallback, /Chrome 155\+.*new tab/);
  await watchPanelConnection(send, panelSessionId);
  stopDisposableSupervisor(nativeHostPath);
  await waitForLossAndReconnect(send, chatSessionId, panelSessionId);
  const reconnect = await verifyReconnect({
    send,
    chatSessionId,
    panelSessionId,
    chatId,
    selection,
    fullTranscript,
    verifyExpectedErrors,
  });
  const screenshot = join(root, "artifacts", "slice8-chat-sidepanel-e2e.png");
  await captureScreenshot(send, panelSessionId, screenshot, true);
  return { splitFallback, screenshot, ...reconnect };
}

async function verifyPanelTitle(send, chatSessionId, panelSessionId) {
  const title = await pageValue(send, chatSessionId, `document.title.replace(/ · Pippin$/, "")`);
  assert.notEqual(title, "New Chat", "The first Ask prompt must name its native chat");
  await waitForText(
    send,
    panelSessionId,
    `document.getElementById("selected-chat-title")?.textContent`,
    title,
    "The side-panel caption did not follow its chat title",
  );
}

async function waitForLossAndReconnect(send, chatSessionId, panelSessionId) {
  await waitUntil(
    () => pageValue(send, panelSessionId, `window.__slice8States?.includes("error")`),
    Boolean,
    15_000,
    "The side-panel Chat did not observe the connection loss",
  );
  await waitForText(
    send,
    panelSessionId,
    `document.querySelector("#chat-frame")?.contentDocument?.getElementById("connection-state")?.dataset.state`,
    "connected",
    "The side-panel Chat did not reconnect",
  );
  await waitForText(
    send,
    chatSessionId,
    `document.getElementById("connection-state")?.dataset.state`,
    "connected",
    "The full Chat did not reconnect",
  );
}

async function verifyReconnect({
  send,
  chatSessionId,
  panelSessionId,
  chatId,
  selection,
  fullTranscript,
  verifyExpectedErrors,
}) {
  const retainedControls = await pageValue(
    send,
    chatSessionId,
    commandExpression(chatId, "chat.controls", { chatId }),
  );
  assert.equal(retainedControls.kind, "command.completed");
  assert.equal(retainedControls.result.controls?.effectiveModel?.provider, selection.provider);
  assert.equal(retainedControls.result.controls?.effectiveModel?.id, selection.id);
  assert.equal(retainedControls.result.controls?.thinkingLevel, selection.thinkingLevel);
  assert.deepEqual(await readTranscript(send, chatSessionId, false), fullTranscript);
  assert.deepEqual(await readTranscript(send, panelSessionId, true), fullTranscript);
  const failures = await pageValue(send, panelSessionId, panelToolEvidenceSummary());
  if (verifyExpectedErrors) {
    assert.equal(failures.staleReference, true);
    assert.equal(failures.ambiguousTarget, true);
  }
  const reconnectStates = await pageValue(send, panelSessionId, `window.__slice8States`);
  return { retainedControls, failures, reconnectStates };
}

function readTranscript(send, sessionId, panel) {
  const transcriptDocument = panel
    ? `globalThis.document.querySelector("#chat-frame")?.contentDocument`
    : "globalThis.document";
  const expression = `(() => {
    const doc=${transcriptDocument};
    const root=doc?.querySelector(".transcript");
    return {
      messages:[...(root?.querySelectorAll('.message-row[data-pi-entry-id]')??[])].map(row=>({
        id:row.dataset.piEntryId,
        role:row.classList.contains('user')?'user':'assistant',
        text:[...row.querySelectorAll('.message-markdown,.message-error')].map(node=>node.textContent).join('')
      })),
      tools:[...(root?.querySelectorAll('.activity-step[data-tool-call-id]')??[])].map(row=>({
        id:row.dataset.toolCallId,state:row.dataset.state
      }))
    };
  })()`;
  return pageValue(send, sessionId, expression);
}

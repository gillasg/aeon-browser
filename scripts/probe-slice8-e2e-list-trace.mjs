import assert from "node:assert/strict";
import { attachPage } from "./probe-browser-control-cft-browser.mjs";
import { runBrowserListTabsProbe } from "./probe-browser-control-cft-chat.mjs";
import {
  captureChatCheckpoint,
  summarizeBrowserToolResults,
} from "./probe-slice8-e2e-diagnostics.mjs";

export async function exerciseBrowserControlListTrace({
  send,
  workerSessionId,
  sessionId,
  chatId,
  serverUrl,
  events,
  report,
  setStage,
  writePending,
}) {
  const borrowed = await attachPage(send, serverUrl);
  await send("Target.activateTarget", { targetId: borrowed.targetId });
  const before = await captureChatCheckpoint(send, workerSessionId, sessionId, chatId, events);
  const startEntryIndex = before.pi?.entries?.length ?? 0;
  await setStage("browser-control list-tabs trace");
  const turn = await runBrowserListTabsProbe({
    send,
    sessionId,
    chatId,
    onCommandSettled: async (checkpoint) => {
      report.browserControlTurns = [checkpoint];
      await writePending(report);
    },
  });
  const checkpoint = await captureChatCheckpoint(send, workerSessionId, sessionId, chatId, events);
  const evidence = summarizeBrowserToolResults(checkpoint.pi, startEntryIndex);
  assert.ok(evidence.toolResultCount > 0, "The short listTabs probe produced no tool result");
  report.browserControlMode = "list_tabs_trace_only";
  report.browserControlListTrace = { ...evidence, turn };
  report.completedBoundaries.push("browser_control_list_tabs_trace");
  await writePending(report);
}

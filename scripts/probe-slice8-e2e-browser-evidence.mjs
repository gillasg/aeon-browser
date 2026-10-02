import assert from "node:assert/strict";
import { waitUntil } from "./probe-browser-control-cft-browser.mjs";
import { runFocusedAmbiguousProbe } from "./probe-browser-control-cft-chat.mjs";
import {
  captureChatCheckpoint,
  summarizeBrowserToolResults,
} from "./probe-slice8-e2e-diagnostics.mjs";

export async function ensureBrowserErrorGeneration({
  send,
  workerSessionId,
  sessionId,
  chatId,
  events,
  borrowedUrl,
  report,
  setStage,
  writePending,
}) {
  const broadCheckpoint = await captureChatCheckpoint(
    send,
    workerSessionId,
    sessionId,
    chatId,
    events,
  );
  const broad = summarizeBrowserToolResults(broadCheckpoint.pi);
  report.browserControlBroadOutcome = broad;
  report.browserControlGeneration = { broad, focused: null };
  await writePending(report);
  assert.equal(
    broad.staleReference,
    true,
    "The broad browser-control turn did not generate STALE_REF",
  );
  if (broad.ambiguousTarget) return;

  const focused = await runFocusedAmbiguousCheck({
    send,
    workerSessionId,
    sessionId,
    chatId,
    events,
    borrowedUrl,
    report,
    setStage,
    writePending,
  });
  report.browserControlGeneration.focused = focused;
  await writePending(report);
}

async function runFocusedAmbiguousCheck({
  send,
  workerSessionId,
  sessionId,
  chatId,
  events,
  borrowedUrl,
  report,
  setStage,
  writePending,
}) {
  const before = await captureChatCheckpoint(send, workerSessionId, sessionId, chatId, events);
  const startEntryIndex = before.pi?.entries?.length ?? 0;
  await setStage("browser-control focused ambiguous target turn");
  const focusedTurn = await runFocusedAmbiguousProbe({
    send,
    sessionId,
    chatId,
    borrowedUrl,
    onCommandSettled: async (checkpoint) => {
      report.browserControlFocusedTurn = checkpoint;
      await writePending(report);
    },
  });
  report.browserControlFocusedTurn = focusedTurn;
  await writePending(report);

  let focusedCheckpoint;
  await waitUntil(
    async () => {
      focusedCheckpoint = await captureChatCheckpoint(
        send,
        workerSessionId,
        sessionId,
        chatId,
        events,
      );
      return summarizeBrowserToolResults(focusedCheckpoint.pi, startEntryIndex);
    },
    (evidence) => evidence.toolResultCount > 0,
    30_000,
    "The focused ambiguous-target turn produced no browser-control result",
  );
  const focused = summarizeBrowserToolResults(focusedCheckpoint.pi, startEntryIndex);
  report.browserControlGeneration.focused = focused;
  await writePending(report);
  assert.equal(
    focused.ambiguousTarget,
    true,
    "The focused browser-control turn did not generate AMBIGUOUS_TARGET",
  );
  return focused;
}

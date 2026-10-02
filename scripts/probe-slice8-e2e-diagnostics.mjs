import { delay, pageValue } from "./probe-browser-control-cft-browser.mjs";
import {
  readAskUiCheckpoint,
  readHandoffStorage,
  readPiState,
  summarizeEvents,
} from "./probe-slice8-handoff-helpers.mjs";

export function installTelemetryCollector(connection, events) {
  connection.socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data));
      if (isInvalidResponseConsole(message)) {
        events.push({
          source: "probe",
          kind: "invalid-response",
          issues: message.params.args[1]?.preview?.properties?.map((item) => item.value) ?? [],
        });
        return;
      }
      if (
        message.method !== "Runtime.bindingCalled" ||
        message.params.name !== "__pippinHandoffProbe"
      )
        return;
      events.push(JSON.parse(message.params.payload));
    } catch {
      /* Only the bounded handoff telemetry is stored. */
    }
  });
}

function isInvalidResponseConsole(message) {
  return (
    message.method === "Runtime.consoleAPICalled" &&
    message.params.type === "error" &&
    message.params.args?.[0]?.value === "Invalid daemon response"
  );
}

export async function listenServer(server) {
  await new Promise((resolveListen, reject) => {
    server.listen(0, "127.0.0.1");
    server.once("listening", resolveListen);
    server.once("error", reject);
  });
}

export async function closeServer(server) {
  if (!server.listening) return true;
  server.closeAllConnections?.();
  return new Promise((resolveClose) => {
    server.close((error) => resolveClose(!error));
  });
}

export function failureCode(stage) {
  if (stage.startsWith("Pi initial response")) return "INITIAL_RESPONSE_UNCONFIRMED";
  if (stage.startsWith("browser-control")) return "BROWSER_CONTROL_CHECK_FAILED";
  if (stage.startsWith("side-panel")) return "SIDE_PANEL_CHECK_FAILED";
  if (stage.startsWith("Chat")) return "CHAT_CONTINUITY_CHECK_FAILED";
  if (stage.startsWith("daemon reconnect")) return "RECONNECT_CHECK_FAILED";
  return "STAGE_FAILED";
}

export function compactHomeEvidence(checkpoint, value) {
  const result = { checkpoint };
  if (typeof value?.passed === "boolean") result.passed = value.passed;
  const compact = {
    connection: compactConnection,
    connectionAssertion: compactConnection,
    catalog: compactCatalog,
    catalogAssertion: compactCatalog,
    selectedModel: compactModel,
    alternateModelSelection: compactModel,
    selectedEffort: (selected) => ({ effort: selected }),
    selectedEffortAssertion: (selection) => ({
      expected: "low",
      actual: selection?.actual ?? null,
    }),
  }[checkpoint];
  return compact ? { ...result, ...compact(value) } : result;
}

function compactConnection(value) {
  const state = value?.actual ?? value;
  return {
    connectionLabel: state?.connectionLabel ?? null,
    connectionError: state?.connectionError ?? null,
  };
}

function compactCatalog(value) {
  const actual = value?.actual ?? value;
  return {
    modelPickerExists: actual?.modelPickerExists ?? null,
    modelCount: actual?.modelCount ?? null,
    modelPickerLabel: actual?.modelPickerLabel ?? null,
  };
}

function compactModel(value) {
  return { model: { provider: value?.provider ?? null, id: value?.id ?? null } };
}

export async function captureChatCheckpoint(send, workerSessionId, sessionId, chatId, events) {
  const ui = await readAskUiCheckpoint(send, sessionId).catch(() => ({ readable: false }));
  const handoff = await readHandoffStorage(send, workerSessionId, chatId);
  const pi = await readPiState(send, sessionId, chatId).catch(() => ({ readable: false }));
  return { ui, handoff, pi, events: summarizeEvents(events) };
}

export function summarizeBrowserToolResults(pi, startEntryIndex = 0) {
  const toolResults = (pi?.entries ?? [])
    .slice(startEntryIndex)
    .filter((entry) => entry.role === "tool");
  return {
    toolResultCount: toolResults.length,
    staleReference: toolResults.some((entry) => entry.toolResultHasStaleReference),
    ambiguousTarget: toolResults.some((entry) => entry.toolResultHasAmbiguousTarget),
  };
}

export async function waitForInitialAnswer({
  send,
  workerSessionId,
  sessionId,
  chatId,
  events,
  submittedAt,
  onCheckpoint,
}) {
  let latest;
  for (const seconds of [5, 15, 30, 60, 90, 120]) {
    const remaining = submittedAt + seconds * 1000 - Date.now();
    if (remaining > 0) await delay(remaining);
    if (seconds < 120 && submittedAt + seconds * 1000 < Date.now() - 1000) continue;
    latest = await captureChatCheckpoint(send, workerSessionId, sessionId, chatId, events);
    latest.scheduledSeconds = seconds;
    latest.elapsedSeconds = Math.round((Date.now() - submittedAt) / 1000);
    await onCheckpoint(latest);
    if (responseCheckpointIsTerminal(latest)) return latest;
  }
  return latest;
}

function responseCheckpointIsTerminal(checkpoint) {
  const assistantSettled =
    assistantIsTerminal(checkpoint.pi) &&
    checkpoint.pi?.active === false &&
    checkpoint.pi?.runState === "idle" &&
    checkpoint.ui?.running === false;
  return responseIsIdle(checkpoint) || checkpoint.ui?.messageErrorPresent || assistantSettled;
}

function responseIsIdle(checkpoint) {
  return (
    checkpoint.ui?.answerMatched &&
    checkpoint.ui?.running === false &&
    checkpoint.pi?.active === false &&
    checkpoint.pi?.runState === "idle"
  );
}

function assistantIsTerminal(pi) {
  return pi?.entries?.some(
    (entry) =>
      entry.role === "assistant" && ["stop", "error", "aborted"].includes(entry.stopReason),
  );
}

export async function capturePanelCheckpoint(send, sessionId, chatId) {
  const expected = JSON.stringify(chatId);
  const expectedSelector = JSON.stringify(`[data-chat-id="${chatId}"]`);
  return pageValue(
    send,
    sessionId,
    `(() => {const status=document.getElementById("panel-status")?.textContent??"";const frame=document.querySelector("#chat-frame");const src=frame?.getAttribute("src")??"";const doc=frame?.contentDocument;const expectedRow=document.querySelector(${expectedSelector});return {status,chatPickerCount:document.querySelectorAll("[data-chat-id]").length,expectedChatListed:Boolean(expectedRow),expectedChatSelected:expectedRow?.getAttribute("aria-selected")==="true",frameExists:Boolean(frame),frameChatMatches:src.includes("chatId="+${expected})&&src.includes("host=panel"),connection:doc?.getElementById("connection-state")?.dataset.state??"missing",userRows:doc?.querySelectorAll(".message-row.user").length??0,assistantRows:doc?.querySelectorAll(".message-row.assistant").length??0,messageErrorPresent:Boolean(doc?.querySelector(".message-error")),splitFallbackVisible:status.includes("Chrome 155")};})()`,
    10_000,
    "Side panel checkpoint",
  );
}

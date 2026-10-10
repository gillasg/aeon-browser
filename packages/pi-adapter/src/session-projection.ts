import type {
  AgentSession,
  AgentSessionEvent,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import {
  type ChatId,
  type PiContextUsage,
  type PiEntryProjection,
  type PiMessageProjection,
  type PiRunState,
  type PiSessionEvent,
  type PiSessionEventListener,
  type PiSessionHandle,
  type PiSessionReference,
} from "@aeon/domain";
import { resultText, safeJsonObject } from "./pi-content-projection.js";
import { submitToPi, createSessionControls } from "./session-controls.js";
import { createPiThreadDelivery } from "./pi-thread-delivery.js";
import { createPiRoutineSupport, type PiRoutinePort } from "./pi-routine.js";
import { projectEffectiveResources } from "./effective-resources.js";
import { reloadPiResources } from "./sdk-resources.js";
import { createSessionTools } from "./session-tools.js";
import { ExtensionUiBridge } from "./extension-ui-bridge.js";
import { projectMessage } from "./pi-message-projection.js";
import { projectChangeDiff } from "./pi-change-diff.js";
import { toEntryProjection } from "./session-entry-projection.js";
type AgentMessageFromEvent = Extract<AgentSessionEvent, { type: "message_start" }>["message"];
export function wrapPiSession(
  session: AgentSession,
  manager: SessionManager,
  reference: PiSessionReference,
  chatId: ChatId,
  extensionUi: ExtensionUiBridge,
  getMcpServers: () => readonly import("@aeon/domain").PiMcpServerStatus[],
): PiSessionHandle {
  const threadDelivery = createPiThreadDelivery(session, manager);
  const routineSupport: PiRoutinePort = createPiRoutineSupport(session, manager, chatId);
  const closeSession = createCloseSession(session, extensionUi, threadDelivery, routineSupport);
  return {
    readToolImage: (toolCallId, index) => readToolImage(manager, toolCallId, index),
    reference,
    submit: (input) => submitToPi(session, input),
    ...threadDelivery,
    ...routineSupport,
    ...createSessionControls(session),
    ...createSessionTools(session, manager),
    extensionUiSnapshot: () => extensionUi.snapshot(),
    answerExtensionUi: (requestId, value) => extensionUi.respond(requestId, value),
    effectiveResources: () => projectEffectiveResources(session, chatId, getMcpServers()),
    reloadResources: () => reloadPiResources(session),
    snapshot: () => {
      const entries = manager.getBranch().map(toEntryProjection);
      const active = !session.isIdle || session.isStreaming;
      return {
        reference,
        workingDirectory: manager.getCwd(),
        entries,
        materialized: existsSync(reference.sessionFile),
        active,
        runState: deriveRunState(active, entries, extensionUi.snapshot().dialogs.length > 0),
        contextUsage: projectContextUsage(session.getContextUsage()),
      };
    },
    subscribe: (listener) => {
      const unsubscribeSession = subscribeSession(session, manager, extensionUi, listener);
      const unsubscribeUi = extensionUi.subscribe((event) => {
        listener(event);
        if (event.kind !== "extension-ui-request" && event.kind !== "extension-ui-resolved") return;
        const pending = extensionUi.snapshot().dialogs.length > 0;
        listener({
          kind: "run-state",
          state: deriveRunState(
            !session.isIdle || session.isStreaming,
            manager.getBranch().map(toEntryProjection),
            pending,
          ),
        });
      });
      return () => {
        unsubscribeSession();
        unsubscribeUi();
      };
    },
    close: closeSession,
  };
}
function subscribeSession(
  session: AgentSession,
  manager: SessionManager,
  extensionUi: ExtensionUiBridge,
  listener: PiSessionEventListener,
): () => void {
  return session.subscribe((event) => {
    const eventType = event.type as string;
    const mapped = toSessionEvent(event, manager, extensionUi);
    if (mapped) listener(mapped);
    if (
      eventType === "agent_settled" ||
      eventType === "session_compact" ||
      eventType === "session_compact_failed" ||
      eventType === "model_select" ||
      eventType === "session_start"
    )
      queueMicrotask(() =>
        listener({
          kind: "context-usage",
          contextUsage: projectContextUsage(session.getContextUsage()),
        }),
      );
    if (event.type === "message_end") {
      queueMicrotask(() =>
        publishPersistedMessage(session.sessionManager, event.message, listener),
      );
    }
  });
}
function projectContextUsage(
  usage: ReturnType<AgentSession["getContextUsage"]>,
): PiContextUsage | null {
  if (!usage || !Number.isSafeInteger(usage.contextWindow) || usage.contextWindow <= 0) return null;
  const tokens =
    usage.tokens !== null && Number.isSafeInteger(usage.tokens) && usage.tokens >= 0
      ? usage.tokens
      : null;
  const percent =
    usage.percent !== null && Number.isFinite(usage.percent) && usage.percent >= 0
      ? usage.percent
      : null;
  return {
    tokens,
    availableTokens: tokens === null ? null : Math.max(0, usage.contextWindow - tokens),
    contextWindow: usage.contextWindow,
    percent,
  };
}
function publishPersistedMessage(
  manager: SessionManager,
  message: AgentMessageFromEvent,
  listener: PiSessionEventListener,
): void {
  for (const entry of manager.getEntries()) {
    const sameCustom =
      message.role === "custom" &&
      entry.type === "custom_message" &&
      entry.customType === message.customType &&
      sameCustomDetails(entry.details, message.details);
    if ((entry.type === "message" && entry.message === message) || sameCustom) {
      listener({ kind: "entry-added", entry: toEntryProjection(entry) });
      return;
    }
  }
}
function sameCustomDetails(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null)
    return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  return (
    typeof leftRecord.deliveryId === "string" && leftRecord.deliveryId === rightRecord.deliveryId
  );
}
function toSessionEvent(
  event: AgentSessionEvent,
  manager: SessionManager,
  extensionUi: ExtensionUiBridge,
): PiSessionEvent | undefined {
  if (event.type === "entry_appended")
    return { kind: "entry-added", entry: toEntryProjection(event.entry) };
  if (isMessageEvent(event)) return projectMessageEvent(event);
  if (isToolEvent(event)) return projectToolEvent(event);
  if (event.type === "turn_start" || event.type === "turn_end")
    return { kind: "turn-boundary", active: event.type === "turn_start" };
  if (event.type === "agent_start") return { kind: "run-state", state: "running-unconfirmed" };
  if (event.type === "agent_settled")
    return extensionUi.snapshot().dialogs.length
      ? { kind: "run-state", state: "needs_attention" }
      : settledRunState(manager);
  if (event.type === "queue_update") {
    return {
      kind: "queue-changed",
      steeringCount: event.steering.length,
      followUpCount: event.followUp.length,
    };
  }
  return undefined;
}
function isMessageEvent(
  event: AgentSessionEvent,
): event is Extract<
  AgentSessionEvent,
  { type: "message_start" | "message_update" | "message_end" }
> {
  return (
    event.type === "message_start" ||
    event.type === "message_update" ||
    event.type === "message_end"
  );
}

function projectMessageEvent(
  event: Extract<AgentSessionEvent, { type: "message_start" | "message_update" | "message_end" }>,
): PiSessionEvent {
  const kind =
    event.type === "message_start"
      ? "message-start"
      : event.type === "message_update"
        ? "message-update"
        : "message-end";
  return { kind, message: projectMessage(event.message) };
}

function isToolEvent(
  event: AgentSessionEvent,
): event is Extract<
  AgentSessionEvent,
  { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
> {
  return (
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end"
  );
}

function projectToolEvent(
  event: Extract<
    AgentSessionEvent,
    { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
  >,
): PiSessionEvent {
  if (event.type === "tool_execution_start")
    return {
      kind: "tool-start",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      arguments: safeJsonObject(event.args),
      ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
    };
  if (event.type === "tool_execution_update")
    return {
      kind: "tool-update",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      arguments: safeJsonObject(event.args),
      partialResult: resultText(event.partialResult),
      ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
    };
  const changeDiff = event.isError ? undefined : projectChangeDiff(event.result);
  return {
    kind: "tool-end",
    ...(changeDiff !== undefined ? { changeDiff } : {}),
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    result: resultText(event.result),
    isError: event.isError,
    ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
  };
}

function settledRunState(manager: SessionManager): PiSessionEvent {
  const entries = manager.getBranch().map(toEntryProjection);
  return { kind: "run-state", state: deriveRunState(false, entries) };
}

function deriveRunState(
  active: boolean,
  entries: readonly PiEntryProjection[],
  needsAttention = false,
): PiRunState {
  if (needsAttention) return "needs_attention";
  if (active) return "running-unconfirmed";
  let latest: PiMessageProjection | null = null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.message) {
      latest = entry.message;
      break;
    }
  }
  if (!latest) return "idle";
  if (["user", "tool"].includes(latest.role)) return "uncertain";
  if (latest.role === "assistant" && ["pending", "toolUse"].includes(latest.stopReason ?? ""))
    return "uncertain";
  return "idle";
}

function createCloseSession(
  session: AgentSession,
  extensionUi: ExtensionUiBridge,
  threadDelivery: { close(): void },
  routineSupport: { close(): void },
): () => Promise<void> {
  let closed = false;
  let closing: Promise<void> | undefined;
  const closeSession = (): Promise<void> => {
    if (closing) return closing;
    if (closed) return Promise.resolve();
    closed = true;
    threadDelivery.close();
    routineSupport.close();
    closing = (async () => {
      try {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        try {
          extensionUi.close();
        } finally {
          session.dispose();
        }
      }
    })();
    return closing;
  };
  return closeSession;
}
import { readToolImage } from "./session-image.js";

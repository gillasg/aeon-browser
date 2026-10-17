import { storedTraceActions } from "./browser-trace-actions.js";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { PiMessageProjection } from "@aeon/domain";
import { projectContent, resultText, safeJsonObject } from "./pi-content-projection.js";
import {
  browserContextFromDetails,
  PI_BROWSER_CONTEXT_CUSTOM_TYPE,
} from "./browser-context-message.js";
import { PI_THREAD_MESSAGE_CUSTOM_TYPE } from "./pi-thread-delivery.js";
import { projectRoutineInvocation } from "./pi-routine.js";
import { projectChangeDiff } from "./pi-change-diff.js";

type AgentMessageFromEvent = Extract<AgentSessionEvent, { type: "message_start" }>["message"];

export function projectMessage(message: AgentMessageFromEvent): PiMessageProjection {
  if (message.role === "user") {
    return { role: "user", content: projectContent(message.content) };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: projectContent(message.content),
      stopReason: message.stopReason,
      ...(message.errorMessage ? { errorMessage: message.errorMessage.slice(0, 2000) } : {}),
    };
  }
  if (message.role === "toolResult") {
    const changeDiff = message.isError ? undefined : projectChangeDiff(message);
    return {
      role: "tool",
      content: projectContent(message.content),
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
      ...(changeDiff !== undefined ? { changeDiff } : {}),
      ...(message.nestedCalls ? { nestedCalls: projectNestedCalls(message.nestedCalls) } : {}),
      ...actionsOf(message.details),
    };
  }
  if (message.role === "custom") return projectCustomMessage(message.customType, message.details);
  return redactedCustomMessage();
}

function projectNestedCalls(value: unknown): NonNullable<PiMessageProjection["nestedCalls"]> {
  if (!isRecord(value) || !Array.isArray(value.calls)) return { complete: false, calls: [] };
  const calls = value.calls.slice(0, 256).flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    if (
      typeof candidate.id !== "string" ||
      !candidate.id.trim() ||
      typeof candidate.name !== "string" ||
      !candidate.name.trim() ||
      !isNestedCallStatus(candidate.status)
    )
      return [];
    const status = candidate.status;
    const argumentBytes = safeInteger(candidate.argumentsBytes);
    const durationMs = safeInteger(candidate.durationMs);
    return [
      {
        id: candidate.id.slice(0, 200),
        name: candidate.name.slice(0, 120),
        ...(isRecord(candidate.arguments)
          ? { arguments: safeJsonObject(candidate.arguments) }
          : {}),
        ...(argumentBytes !== undefined ? { argumentsBytes: argumentBytes } : {}),
        status,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(typeof candidate.error === "string"
          ? { error: resultText(candidate.error).slice(0, 500) }
          : {}),
      },
    ];
  });
  return {
    complete: value.complete === true && calls.length === value.calls.length,
    calls,
  };
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isNestedCallStatus(
  value: unknown,
): value is NonNullable<PiMessageProjection["nestedCalls"]>["calls"][number]["status"] {
  return value === "ok" || value === "error" || value === "unfinished";
}

export function projectCustomMessage(customType: string, details: unknown): PiMessageProjection {
  const routine = projectRoutineInvocation(customType, details);
  if (routine) return routine;
  if (customType === PI_THREAD_MESSAGE_CUSTOM_TYPE && isRecord(details)) {
    const deliveryId = stringValue(details.deliveryId);
    const senderChatId = stringValue(details.senderChatId);
    const senderTitle = stringValue(details.senderTitle);
    const message = stringValue(details.message);
    if (deliveryId && senderChatId && senderTitle && message) {
      return {
        role: "custom",
        content: [
          {
            type: "thread-message",
            deliveryId,
            senderChatId,
            senderTitle,
            message,
            ...(typeof details.inReplyTo === "string" ? { inReplyTo: details.inReplyTo } : {}),
          },
        ],
      };
    }
  }
  if (customType !== PI_BROWSER_CONTEXT_CUSTOM_TYPE) return redactedCustomMessage();
  const records =
    isRecord(details) && Array.isArray(details.browserContexts)
      ? details.browserContexts.slice(0, 9).flatMap((browserContext) => {
          const record = browserContextFromDetails({ browserContext });
          return record ? [record] : [];
        })
      : [browserContextFromDetails(details)].filter((record) => record !== undefined);
  return {
    role: "custom",
    content: records.map((record) => ({ type: "browser-context", record })),
  };
}

function redactedCustomMessage(): PiMessageProjection {
  return { role: "custom", content: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function actionsOf(
  details: unknown,
): { actions: NonNullable<PiMessageProjection["actions"]> } | Record<string, never> {
  const actions = storedTraceActions(details);
  return actions ? { actions } : {};
}

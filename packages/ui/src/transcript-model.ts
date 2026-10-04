import { insertAssistantEntry, separatesToolBatch } from "./transcript-assistant-entry.js";
import { updateTurnTiming, type TurnTiming } from "./turn-timing.js";
import { timestampMs, blockText, hasRenderableContent } from "./transcript-content.js";
import type {
  PiContentBlockDto,
  PiEntryDto,
  PiMessageDto,
  PiSessionEventDto,
} from "@pippin/protocol";

export interface ToolStep {
  key: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  argumentsBytes?: number;
  parentToolCallId?: string;
  nestedCalls?: NonNullable<PiMessageDto["nestedCalls"]>;
  state: "running" | "complete" | "failed" | "pending";
  partialResult: string;
  result: string;
  isError: boolean;
  startedAt: number;
  endedAt?: number;
  lastActivityAt?: number;
  resultUnavailable?: boolean;
  changeDiff?: string;
  images?: Array<{ mimeType: string; byteLength: number }>;
}

export interface ToolGroup {
  key: string;
  steps: ToolStep[];
}

export type TranscriptRow = (
  | { kind: "entry"; key: string; entry: PiEntryDto }
  | {
      kind: "context-orphan";
      key: string;
      entry: PiEntryDto;
      targetEntryId: string | null;
    }
  | { kind: "transient"; key: string; message: PiMessageDto }
  | { kind: "tool-group"; key: string; group: ToolGroup }
) & { timing?: TurnTiming };

interface PendingBrowserContext {
  orphanKey: string;
  entry: PiEntryDto;
  context: Extract<PiContentBlockDto, { type: "browser-context" }>;
}

export class TranscriptModel {
  rows: TranscriptRow[] = [];
  private readonly entryIds = new Set<string>();
  private readonly steps = new Map<string, ToolStep>();
  private activeGroup: ToolGroup | undefined;
  private readonly transients = new Map<string, string>();
  private readonly pendingContexts = new Map<string, PendingBrowserContext[]>();
  setSnapshot(entries: readonly PiEntryDto[]): void {
    this.rows = [];
    this.entryIds.clear();
    this.steps.clear();
    this.activeGroup = undefined;
    this.transients.clear();
    this.pendingContexts.clear();
    for (const entry of entries) this.addEntry(entry);
  }

  apply(event: PiSessionEventDto): void {
    if (event.kind === "view-replaced") {
      this.setSnapshot(event.entries);
      return;
    }
    if (event.kind === "entry-added") this.addEntry(event.entry);
    else if (event.kind === "run-state") {
      if (event.state === "idle") this.activeGroup = undefined;
    } else if (
      event.kind === "message-start" ||
      event.kind === "message-update" ||
      event.kind === "message-end"
    )
      this.applyMessageEvent(event);
    else if (event.kind === "tool-start")
      Object.assign(this.stepFor(event.toolCallId, event.toolName, event.parentToolCallId), {
        arguments: event.arguments,
        state: "running",
      });
    else if (event.kind === "tool-update")
      Object.assign(this.stepFor(event.toolCallId, event.toolName, event.parentToolCallId), {
        arguments: event.arguments,
        partialResult: event.partialResult,
        state: "running",
      });
    else if (event.kind === "tool-end")
      Object.assign(this.stepFor(event.toolCallId, event.toolName, event.parentToolCallId), {
        result: event.result,
        isError: event.isError,
        state: event.isError ? "failed" : "complete",
        endedAt: Date.now(),
        resultUnavailable: false,
        changeDiff: event.changeDiff,
      });
    updateTurnTiming(this.rows, event);
    this.rows = [...this.rows];
  }

  private addEntry(entry: PiEntryDto): void {
    if (this.entryIds.has(entry.entryId)) return;
    this.entryIds.add(entry.entryId);
    const message = entry.message;
    if (!message) return;
    if (message.role === "custom") {
      for (const context of message.content)
        if (context.type === "browser-context") this.attachBrowserContext(entry, context);
      if (
        message.content.some(
          (block) =>
            block.type === "thread-message" ||
            block.type === "routine-invocation" ||
            block.type === "routine-result",
        )
      )
        this.rows.push({ kind: "entry", key: `entry:${entry.entryId}`, entry });
      return;
    }
    this.removeTransient(message.role);
    if (message.role === "tool") return this.addToolResult(message, entry.timestamp);
    if (message.role === "assistant") return this.addAssistantEntry(entry);
    const pending = this.pendingContexts.get(entry.entryId);
    if (pending) {
      this.pendingContexts.delete(entry.entryId);
      this.rows = this.rows.filter(
        (row) => !pending.some(({ orphanKey }) => row.key === orphanKey),
      );
      entry = {
        ...entry,
        message: {
          ...message,
          content: [...pending.map(({ context }) => context), ...message.content],
        },
      };
    }
    this.rows.push({ kind: "entry", key: `entry:${entry.entryId}`, entry });
  }
  private applyMessageEvent(event: Extract<PiSessionEventDto, { message: PiMessageDto }>): void {
    if (event.message.role === "tool") {
      if (event.kind === "message-end") this.addToolResult(event.message, new Date().toISOString());
      return;
    }
    this.updateTransient(event.message);
    for (const block of event.message.content) {
      if (block.type !== "tool-call") continue;
      const existed = this.steps.has(block.toolCallId);
      const step = this.stepFor(block.toolCallId, block.toolName);
      step.arguments = block.arguments;
      if (!existed) step.state = "pending";
    }
  }

  private attachBrowserContext(
    entry: PiEntryDto,
    context: Extract<PiContentBlockDto, { type: "browser-context" }>,
  ): void {
    const targetEntryId = entry.parentEntryId;
    const targetIndex = this.rows.findIndex(
      (row) =>
        row.kind === "entry" &&
        row.entry.entryId === targetEntryId &&
        row.entry.message?.role === "user",
    );
    if (targetIndex >= 0) {
      const row = this.rows[targetIndex];
      if (!row || row.kind !== "entry" || row.entry.message?.role !== "user") return;
      this.rows[targetIndex] = {
        ...row,
        entry: {
          ...row.entry,
          message: { ...row.entry.message, content: [context, ...row.entry.message.content] },
        },
      };
      return;
    }
    const orphanKey = `orphan-context:${entry.entryId}:${context.record.contextId}`;
    this.rows.push({ kind: "context-orphan", key: orphanKey, entry, targetEntryId });
    if (targetEntryId) {
      const pending = this.pendingContexts.get(targetEntryId) ?? [];
      pending.push({ orphanKey, entry, context });
      this.pendingContexts.set(targetEntryId, pending);
    }
  }

  private removeTransient(role: PiMessageDto["role"]): void {
    const key = this.transients.get(role);
    if (!key) return;
    this.rows = this.rows.filter((row) => row.key !== key);
    this.transients.delete(role);
  }

  private addToolResult(message: PiMessageDto, timestamp: string): void {
    if (!message.toolCallId) return;
    const endedAt = timestampMs(timestamp) ?? Date.now();
    const step = this.stepFor(message.toolCallId, message.toolName ?? "tool", undefined, endedAt);
    step.result = blockText(message.content);
    step.images = message.content.flatMap((block) =>
      block.type === "image" ? [{ mimeType: block.mimeType, byteLength: block.byteLength }] : [],
    );
    if (message.changeDiff !== undefined) step.changeDiff = message.changeDiff;
    step.isError = message.isError ?? false;
    step.state = step.isError ? "failed" : step.state === "running" ? "running" : "complete";
    step.endedAt = endedAt;
    if (message.nestedCalls) {
      step.nestedCalls = message.nestedCalls;
      this.restoreNestedCalls(step, message.nestedCalls, endedAt);
    } else delete step.nestedCalls;
  }

  private addAssistantEntry(entry: PiEntryDto): void {
    const message = entry.message;
    if (!message || message.role !== "assistant") return;
    const calls = message.content.filter((block) => block.type === "tool-call");
    if (!calls.length || separatesToolBatch(message)) this.activeGroup = undefined;
    if (hasRenderableContent(message.content) || message.stopReason === "error")
      insertAssistantEntry(this.rows, entry);
    const timestamp = timestampMs(entry.timestamp) ?? Date.now();
    for (const block of calls) {
      const step = this.stepFor(block.toolCallId, block.toolName, undefined, timestamp);
      step.arguments = block.arguments;
      step.startedAt = timestamp;
    }
  }

  private updateTransient(message: PiMessageDto): void {
    if (message.role === "custom" || !hasRenderableContent(message.content)) return;
    const key = `transient:${message.role}`;
    const index = this.rows.findIndex((row) => row.key === key);
    const row: TranscriptRow = { kind: "transient", key, message };
    if (index < 0) {
      if (message.role === "assistant" && separatesToolBatch(message)) this.activeGroup = undefined;
      this.rows.push(row);
    } else this.rows[index] = row;
    this.transients.set(message.role, key);
  }

  private restoreNestedCalls(
    parent: ToolStep,
    nestedCalls: NonNullable<PiMessageDto["nestedCalls"]>,
    endedAt: number,
  ): void {
    for (const call of nestedCalls.calls) {
      const step = this.stepFor(call.id, call.name, parent.toolCallId, endedAt);
      const hasPreviousEnd = step.endedAt !== undefined;
      const hasLiveResult = step.endedAt !== undefined && !step.resultUnavailable;
      if (call.arguments) step.arguments = call.arguments;
      if (call.argumentsBytes !== undefined) step.argumentsBytes = call.argumentsBytes;
      step.state =
        call.status === "ok" ? "complete" : call.status === "error" ? "failed" : "pending";
      step.isError = call.status === "error";
      if (call.error) {
        step.result = call.error;
        step.resultUnavailable = false;
      } else if (!hasLiveResult) step.resultUnavailable = true;
      const end = endedAt;
      if (call.durationMs !== undefined && !hasPreviousEnd)
        step.startedAt = Math.max(0, end - call.durationMs);
      step.endedAt = end;
      step.lastActivityAt = end;
    }
  }

  private stepFor(
    toolCallId: string,
    toolName: string,
    parentToolCallId?: string,
    lastActivityAt = Date.now(),
  ): ToolStep {
    let step = this.steps.get(toolCallId);
    if (step) {
      if (parentToolCallId) step.parentToolCallId = parentToolCallId;
      step.lastActivityAt = lastActivityAt;
      return step;
    }
    const group = this.activeGroup ?? this.createGroup(toolCallId);
    step = {
      key: `tool:${toolCallId}`,
      toolCallId,
      toolName,
      ...(parentToolCallId ? { parentToolCallId } : {}),
      arguments: {},
      state: "pending",
      partialResult: "",
      result: "",
      isError: false,
      startedAt: Date.now(),
      lastActivityAt,
      resultUnavailable: false,
    };
    this.steps.set(toolCallId, step);
    group.steps.push(step);
    return step;
  }

  private createGroup(firstToolCallId: string): ToolGroup {
    const group: ToolGroup = { key: `tool-group:${firstToolCallId}`, steps: [] };
    this.activeGroup = group;
    this.rows.push({ kind: "tool-group", key: group.key, group });
    return group;
  }
}

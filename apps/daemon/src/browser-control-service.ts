import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  BrowserExecutorRequestSchema,
  BrowserOperationCallSchema,
  BrowserOperationResultSchema,
  type BrowserExecutorRequest,
  type BrowserExecutorResult,
  type BrowserStep,
  type BrowserTargetKey,
} from "@pippin/protocol";
import { BrowserInventoryRegistry } from "./browser-inventory-registry.js";
import {
  listBrowserTabs,
  safeUrl,
  normalizedUrl,
  targetIdentity,
  sameTarget,
} from "./browser-control-values.js";

const BATCH_BUDGET_MS = 30_000;
const STEP_TIMEOUT_MS = 12_000;
type Ownership = "borrowed" | "agent-created";
type AcquisitionSource = "user-context" | "user-picker" | "agent-open";
interface Association {
  target: BrowserTargetKey;
  ownership: Ownership;
  source: AcquisitionSource;
}
interface Pending {
  chatId: string;
  socket: WebSocket;
  operationId: string;
  finish(result?: BrowserExecutorResult, code?: string): void;
  timer: NodeJS.Timeout;
}

export class BrowserControlService {
  private inventories: BrowserInventoryRegistry | undefined;
  private readonly executors = new Map<string, WebSocket>();
  private readonly pending = new Map<string, Pending>();
  private readonly associations = new Map<string, Map<string, Association>>();
  private readonly claims = new Map<string, string>();
  private claimGeneration = 0;

  useInventories(inventories: BrowserInventoryRegistry): void {
    this.inventories = inventories;
  }

  isInstanceAvailable(clientInstanceId: string): boolean {
    return this.executors.has(clientInstanceId) && !!this.inventories?.get(clientInstanceId);
  }

  attachContext(
    chatId: string,
    target: BrowserTargetKey,
    capturedUrl: string,
  ): "attached" | "stale" | "lost" | "offline" {
    if (!this.inventories) return "offline";
    if (!this.connected(target.clientInstanceId)) return "offline";
    const tab = this.inventories.findTarget(target);
    if (!tab || !safeUrl(tab.url)) return "lost";
    if (!safeUrl(capturedUrl) || normalizedUrl(tab.url) !== normalizedUrl(capturedUrl))
      return "stale";
    this.setAssociation(chatId, target, "borrowed", "user-context");
    return "attached";
  }

  connectExecutor(clientInstanceId: string, socket: WebSocket): void {
    this.executors.set(clientInstanceId, socket);
    socket.once("close", () => {
      if (this.executors.get(clientInstanceId) === socket) this.executors.delete(clientInstanceId);
      for (const pending of this.pending.values())
        if (pending.socket === socket) pending.finish(undefined, "BROWSER_OFFLINE");
    });
  }

  handleExecutorResult(candidate: unknown, socket: WebSocket): boolean {
    const parsed = BrowserOperationResultSchema.safeParse(candidate);
    if (!parsed.success) return false;
    const pending = this.pending.get(parsed.data.requestId);
    if (!pending || pending.socket !== socket || pending.operationId !== parsed.data.operationId)
      return true;
    if (parsed.data.ok) pending.finish(parsed.data.result);
    else
      pending.finish(
        undefined,
        parsed.data.code === "DAEMON_OFFLINE" ? "BROWSER_OFFLINE" : parsed.data.code,
      );
    return true;
  }

  async execute(
    chatId: string,
    toolCallId: string,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    if (typeof raw === "object" && raw !== null && "release" in raw && raw.release === true) {
      this.release(chatId, "reset" in raw && raw.reset === true);
      return JSON.stringify({ released: true });
    }
    if (signal?.aborted) return JSON.stringify({ error: "CANCELLED" });
    const abort = () => this.release(chatId);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await this.executeBatch(chatId, toolCallId, raw, signal);
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private release(chatId: string, reset = false): void {
    for (const pending of this.pending.values())
      if (pending.chatId === chatId) pending.finish(undefined, "OPERATION_FAILED");
    for (const socket of this.executors.values())
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ kind: "browser.release", chatId, reset }));
  }

  private async executeBatch(
    chatId: string,
    toolCallId: string,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    const parsed = BrowserOperationCallSchema.safeParse(raw);
    if (!parsed.success)
      return JSON.stringify({
        error: "INVALID_TARGET",
        detail: "Browser arguments did not match the closed operation schema.",
      });
    const operationId = randomUUID();
    const deadline = Date.now() + BATCH_BUDGET_MS;
    const dispositions: {
      index: number;
      disposition: "completed" | "failed" | "skipped";
      code?: string;
      result?: BrowserExecutorResult;
    }[] = [];
    for (const [index, step] of parsed.data.steps.entries()) {
      if (Date.now() >= deadline || signal?.aborted) {
        dispositions.push({ index, disposition: "failed", code: "TIMEOUT" });
        break;
      }
      const outcome = await this.executeStep(
        chatId,
        toolCallId,
        operationId,
        step,
        Math.min(STEP_TIMEOUT_MS, deadline - Date.now()),
      );
      if (outcome.result)
        dispositions.push({ index, disposition: "completed", result: outcome.result });
      else {
        dispositions.push({
          index,
          disposition: "failed",
          code: outcome.code ?? "OPERATION_FAILED",
        });
        for (let skipped = index + 1; skipped < parsed.data.steps.length; skipped++)
          dispositions.push({
            index: skipped,
            disposition: "skipped",
            code: "STOPPED_AFTER_ERROR",
          });
        break;
      }
    }
    return JSON.stringify({ operationId, toolCallId, steps: dispositions });
  }

  private async executeStep(
    chatId: string,
    toolCallId: string,
    operationId: string,
    step: BrowserStep,
    timeoutMs: number,
  ): Promise<{ result?: BrowserExecutorResult; code?: string }> {
    if (!this.inventories) return { code: "DAEMON_OFFLINE" };
    if (step.op === "listTabs") return listBrowserTabs(step, this.executors, this.inventories);
    if (step.op === "openTab")
      return this.executeOpenTab(chatId, toolCallId, operationId, step, timeoutMs);
    if (step.op === "attachTab") return this.executeAttachTab(chatId, step);
    return this.executeTargetedStep(chatId, toolCallId, operationId, step, timeoutMs);
  }

  private async executeOpenTab(
    chatId: string,
    toolCallId: string,
    operationId: string,
    step: Extract<BrowserStep, { op: "openTab" }>,
    timeoutMs: number,
  ): Promise<{ result?: BrowserExecutorResult; code?: string }> {
    const socket = this.executors.get(step.clientInstanceId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return { code: "BROWSER_OFFLINE" };
    const opened = await this.dispatch(socket, chatId, toolCallId, operationId, step, timeoutMs);
    if (opened.result?.kind === "tab")
      this.setAssociation(chatId, opened.result.tab.target, "agent-created", "agent-open");
    return opened;
  }

  private executeAttachTab(
    chatId: string,
    step: Extract<BrowserStep, { op: "attachTab" }>,
  ): { result?: BrowserExecutorResult; code?: string } {
    const tab = this.inventories?.findTarget(step.target);
    if (!this.connected(step.target.clientInstanceId)) return { code: "BROWSER_OFFLINE" };
    if (!tab || !safeUrl(tab.url)) return { code: "TARGET_LOST" };
    this.setAssociation(chatId, step.target, "borrowed", "user-picker");
    return { result: { kind: "tab", tab } };
  }

  private async executeTargetedStep(
    chatId: string,
    toolCallId: string,
    operationId: string,
    step: Exclude<BrowserStep, { op: "listTabs" | "openTab" | "attachTab" }>,
    timeoutMs: number,
  ): Promise<{ result?: BrowserExecutorResult; code?: string }> {
    if (!this.getAssociation(chatId, step.target)) return { code: "TARGET_LOST" };
    const tab = this.inventories?.findTarget(step.target);
    if (!tab || !safeUrl(tab.url)) return { code: "TARGET_LOST" };
    const socket = this.executors.get(step.target.clientInstanceId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return { code: "BROWSER_OFFLINE" };
    const key = targetIdentity(step.target);
    if (this.claims.has(key)) return { code: "CLAIM_CONFLICT" };
    const claimId = randomUUID();
    const claimGeneration = (this.claimGeneration = Math.max(
      this.claimGeneration + 1,
      Date.now() * 1000,
    ));
    this.claims.set(key, claimId);
    try {
      return await this.dispatch(
        socket,
        chatId,
        toolCallId,
        operationId,
        step,
        timeoutMs,
        claimId,
        claimGeneration,
        tab.documentEpoch,
      );
    } finally {
      if (this.claims.get(key) === claimId) this.claims.delete(key);
    }
  }

  private async dispatch(
    socket: WebSocket,
    chatId: string,
    toolCallId: string,
    operationId: string,
    step: BrowserStep,
    timeoutMs: number,
    claimId?: string,
    claimGeneration?: number,
    expectedDocumentEpoch?: number,
  ): Promise<{ result?: BrowserExecutorResult; code?: string }> {
    const request = BrowserExecutorRequestSchema.parse({
      kind: "browser.operation",
      requestId: randomUUID(),
      operationId,
      toolCallId,
      chatId,
      step,
      ...(claimId ? { claimId, claimGeneration, expectedDocumentEpoch } : {}),
    });
    return this.sendAndWait(socket, request, timeoutMs);
  }

  private sendAndWait(
    socket: WebSocket,
    request: BrowserExecutorRequest,
    timeoutMs: number,
  ): Promise<{ result?: BrowserExecutorResult; code?: string }> {
    return new Promise((resolve) => {
      const finish = (result?: BrowserExecutorResult, code?: string) => {
        const pending = this.pending.get(request.requestId);
        if (!pending) return;
        this.pending.delete(request.requestId);
        clearTimeout(pending.timer);
        resolve(result ? { result } : { code: code ?? "BROWSER_OFFLINE" });
      };
      const timer = setTimeout(() => finish(undefined, "TIMEOUT"), timeoutMs);
      this.pending.set(request.requestId, {
        chatId: request.chatId,
        socket,
        operationId: request.operationId,
        finish,
        timer,
      });
      socket.send(JSON.stringify(request), (error) => {
        if (error) finish(undefined, "BROWSER_OFFLINE");
      });
    });
  }

  private connected = (clientInstanceId: string): boolean =>
    this.executors.get(clientInstanceId)?.readyState === WebSocket.OPEN;

  private setAssociation(
    chatId: string,
    target: BrowserTargetKey,
    ownership: Ownership,
    source: AcquisitionSource,
  ): void {
    let byTarget = this.associations.get(chatId);
    if (!byTarget) this.associations.set(chatId, (byTarget = new Map()));
    byTarget.set(targetIdentity(target), { target, ownership, source });
  }

  private getAssociation(chatId: string, target: BrowserTargetKey): Association | undefined {
    const association = this.associations.get(chatId)?.get(targetIdentity(target));
    return association && sameTarget(association.target, target) ? association : undefined;
  }
}

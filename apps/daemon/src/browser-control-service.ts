import { sendBrowserRequest, type BrowserPending } from "./browser-operation-pending.js";
import { requiresBrowserActions, requiresBrowserRuntime } from "./browser-capabilities.js";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  BrowserExecutorRequestSchema,
  BrowserPopupSchema,
  BrowserOperationResultSchema,
  type BrowserExecutorResult,
  type BrowserStep,
  type BrowserTargetKey,
} from "@pippin/protocol";
import { executeBrowserBatch } from "./browser-batch.js";
import type { SiteScriptService } from "./site-script-service.js";
import { BrowserInventoryRegistry } from "./browser-inventory-registry.js";
import {
  listBrowserTabs,
  safeUrl,
  normalizedUrl,
  targetIdentity,
  sameTarget,
} from "./browser-control-values.js";
type Ownership = "borrowed" | "agent-created";
type AcquisitionSource = "user-context" | "user-picker" | "agent-open";
interface Association {
  target: BrowserTargetKey;
  ownership: Ownership;
  source: AcquisitionSource;
}
export class BrowserControlService {
  private inventories: BrowserInventoryRegistry | undefined;
  private readonly executors = new Map<string, WebSocket>();
  private readonly pending = new Map<string, BrowserPending>();
  private readonly associations = new Map<string, Map<string, Association>>();
  private readonly claims = new Map<string, string>();
  private claimGeneration = 0;
  private scripts: SiteScriptService | undefined;
  private readonly scriptClients = new Set<string>();
  private readonly actionClients = new Map<string, boolean>();
  private readonly runtimeClients = new Set<string>();
  useSiteScripts(scripts: SiteScriptService): void {
    this.scripts = scripts;
  }
  resyncScripts(clientId: string): void {
    const socket = this.executors.get(clientId);
    if (this.scriptClients.has(clientId) && socket?.readyState === WebSocket.OPEN)
      this.scripts?.sync(clientId, socket);
  }
  targetUrl(chatId: string, target: BrowserTargetKey): string {
    if (!this.getAssociation(chatId, target))
      throw new Error("Attach the exact browser target first.");
    const tab = this.inventories?.findTarget(target);
    if (!tab || !safeUrl(tab.url)) throw new Error("TARGET_LOST");
    return tab.url;
  }
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
  connectExecutor(
    clientInstanceId: string,
    socket: WebSocket,
    supportsScripts = false,
    supportsActions = false,
    supportsRuntime = false,
  ): void {
    this.actionClients.set(clientInstanceId, supportsActions);
    if (supportsRuntime) this.runtimeClients.add(clientInstanceId);
    else this.runtimeClients.delete(clientInstanceId);
    if (supportsScripts) this.scriptClients.add(clientInstanceId);
    else this.scriptClients.delete(clientInstanceId);
    this.executors.set(clientInstanceId, socket);
    this.resyncScripts(clientInstanceId);
    socket.once("close", () => {
      if (this.executors.get(clientInstanceId) === socket) {
        this.executors.delete(clientInstanceId);
        this.actionClients.delete(clientInstanceId);
        this.runtimeClients.delete(clientInstanceId);
        this.scriptClients.delete(clientInstanceId);
      }
      for (const pending of this.pending.values())
        if (pending.socket === socket) pending.finish(undefined, "BROWSER_OFFLINE");
    });
  }
  handleExecutorResult(candidate: unknown, socket: WebSocket): boolean {
    if (this.adoptPopup(candidate, socket)) return true;
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
        parsed.data.detail,
      );
    return true;
  }
  async execute(
    chatId: string,
    toolCallId: string,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    const special = this.executeSpecial(chatId, toolCallId, raw, signal);
    if (special) return special;
    if (signal?.aborted) return JSON.stringify({ error: "CANCELLED" });
    const abort = () => this.release(chatId);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await executeBrowserBatch(
        raw,
        toolCallId,
        (id, step, timeout) => this.executeStep(chatId, toolCallId, id, step, timeout),
        signal,
      );
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  private executeSpecial(
    chatId: string,
    callId: string,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<string> | undefined {
    if (typeof raw !== "object" || raw === null) return;
    if ("browserInfo" in raw && raw.browserInfo === true)
      return Promise.resolve(
        JSON.stringify({
          clientInstanceIds: [...this.executors.keys()].filter((id) =>
            this.isInstanceAvailable(id),
          ),
        }),
      );
    if ("siteScript" in raw)
      return (
        this.scripts?.execute(chatId, callId, raw.siteScript, signal) ??
        Promise.resolve(JSON.stringify({ error: "UNSUPPORTED" }))
      );
    if ("release" in raw && raw.release === true) {
      this.release(chatId, "reset" in raw && raw.reset === true);
      return Promise.resolve(JSON.stringify({ released: true }));
    }
    return;
  }
  private release(chatId: string, reset = false): void {
    for (const pending of this.pending.values())
      if (pending.chatId === chatId) pending.finish(undefined, "OPERATION_FAILED");
    for (const socket of this.executors.values())
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ kind: "browser.release", chatId, reset }));
  }
  private async executeStep(
    chatId: string,
    toolCallId: string,
    operationId: string,
    step: BrowserStep,
    timeoutMs: number,
  ): Promise<{ result?: BrowserExecutorResult; code?: string; detail?: string }> {
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
  ): Promise<{ result?: BrowserExecutorResult; code?: string; detail?: string }> {
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
  ): { result?: BrowserExecutorResult; code?: string; detail?: string } {
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
  ): Promise<{ result?: BrowserExecutorResult; code?: string; detail?: string }> {
    if (!this.runtimeAvailable(step))
      return {
        code: "UNSUPPORTED",
        detail: "Reload Aeon in chrome://extensions to load the new browser runtime.",
      };
    if (requiresBrowserActions(step) && !this.actionClients.get(step.target.clientInstanceId))
      return {
        code: "UNSUPPORTED",
        detail:
          "The extension still has the older browser executor loaded. Reload Aeon in chrome://extensions, then retry this browser task.",
      };
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
  ): Promise<{ result?: BrowserExecutorResult; code?: string; detail?: string }> {
    const request = BrowserExecutorRequestSchema.parse({
      kind: "browser.operation",
      requestId: randomUUID(),
      operationId,
      toolCallId,
      chatId,
      step,
      ...(claimId ? { claimId, claimGeneration, expectedDocumentEpoch } : {}),
    });
    return sendBrowserRequest(this.pending, socket, request, timeoutMs, () =>
      this.release(request.chatId),
    );
  }
  private adoptPopup(candidate: unknown, socket: WebSocket): boolean {
    const popup = BrowserPopupSchema.safeParse(candidate);
    if (!popup.success) return false;
    const { chatId, opener, tab } = popup.data;
    if (
      this.executors.get(opener.clientInstanceId) !== socket ||
      !this.getAssociation(chatId, opener) ||
      tab.target.clientInstanceId !== opener.clientInstanceId ||
      tab.target.browserRunId !== opener.browserRunId ||
      !safeUrl(tab.url)
    )
      return true;
    const live = this.inventories?.findTarget(tab.target);
    if (live) this.setAssociation(chatId, live.target, "agent-created", "agent-open");
    return true;
  }
  private connected = (clientInstanceId: string): boolean =>
    this.executors.get(clientInstanceId)?.readyState === WebSocket.OPEN;
  private runtimeAvailable(
    step: Exclude<BrowserStep, { op: "listTabs" | "openTab" | "attachTab" }>,
  ): boolean {
    return !requiresBrowserRuntime(step) || this.runtimeClients.has(step.target.clientInstanceId);
  }
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

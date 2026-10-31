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
} from "@aeon/protocol";
import { executeBrowserBatch } from "./browser-batch.js";
import { isWriteStep } from "./browser-step-write.js";
import { BrowserCodeCells, type BrowserCodeCellInput } from "./browser-code-cells.js";
import type { SiteScriptService } from "./site-script-service.js";
import { CdpService } from "./cdp-service.js";
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
  private readonly codeClients = new Set<string>();
  private startupTidied = new Set<string>();
  private startupTidy = false;
  private ownerTitles: ((chatId: string) => string | undefined) | undefined;
  private spaceForChat: ((chatId: string) => "window" | "tabs" | undefined) | undefined;
  private cdpService: CdpService | undefined;
  private readonly cells = new BrowserCodeCells((chatId, target) =>
    this.setAssociation(chatId, target, "agent-created", "agent-open"),
  );
  useSiteScripts(scripts: SiteScriptService): void {
    this.scripts = scripts;
  }
  /** How a chat names its tab group; routines and sessions prefix themselves. */
  useOwnerTitles(lookup: (chatId: string) => string | undefined): void {
    this.ownerTitles = lookup;
  }
  /** Where a chat's tabs go: its own window for routines and outside sessions, else the user's. */
  useDefaultSpaces(lookup: (chatId: string) => "window" | "tabs" | undefined): void {
    this.spaceForChat = lookup;
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
    supportsCode = false,
  ): void {
    if (supportsCode) this.codeClients.add(clientInstanceId);
    else this.codeClients.delete(clientInstanceId);
    this.actionClients.set(clientInstanceId, supportsActions);
    if (supportsRuntime) this.runtimeClients.add(clientInstanceId);
    else this.runtimeClients.delete(clientInstanceId);
    if (supportsScripts) this.scriptClients.add(clientInstanceId);
    else this.scriptClients.delete(clientInstanceId);
    this.executors.set(clientInstanceId, socket);
    this.cells.rebind(clientInstanceId, socket);
    this.resyncScripts(clientInstanceId);
    this.tidyOnStartup(clientInstanceId, socket);
    socket.once("close", () => {
      if (this.executors.get(clientInstanceId) === socket) {
        this.executors.delete(clientInstanceId);
        this.actionClients.delete(clientInstanceId);
        this.runtimeClients.delete(clientInstanceId);
        this.scriptClients.delete(clientInstanceId);
        this.codeClients.delete(clientInstanceId);
      }
      for (const pending of this.pending.values())
        if (pending.socket === socket)
          setTimeout(() => pending.finish(undefined, "BROWSER_OFFLINE"), 60_000);
    });
  }
  handleExecutorResult(candidate: unknown, socket: WebSocket): boolean {
    if (this.cdpService?.handle(candidate)) return true;
    if (this.cells.handle(candidate, socket)) return true;
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
    if ("codeCell" in raw)
      return this.runCode(chatId, callId, raw.codeCell as BrowserCodeCellInput, signal);
    if ("release" in raw && raw.release === true)
      return this.releaseRequest(chatId, raw as { reset?: unknown; tidy?: unknown });
    return;
  }
  private releaseRequest(
    chatId: string,
    raw: { reset?: unknown; tidy?: unknown },
  ): Promise<string> {
    this.release(chatId, raw.reset === true, raw.tidy === true);
    return Promise.resolve(JSON.stringify({ released: true }));
  }
  private async runCode(
    chatId: string,
    toolCallId: string,
    input: BrowserCodeCellInput,
    signal?: AbortSignal,
  ): Promise<string> {
    const deadline = Date.now() + 60_000;
    let { clientInstanceId, available } = this.pickCodeClient(chatId);
    while (!clientInstanceId && !signal?.aborted && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 250));
      ({ clientInstanceId, available } = this.pickCodeClient(chatId));
    }
    if (!clientInstanceId) return this.codeUnavailable(available);
    const socket = this.executors.get(clientInstanceId);
    if (!socket) return JSON.stringify({ error: "BROWSER_OFFLINE" });
    const targets = this.liveTargets(chatId).filter((t) => t.clientInstanceId === clientInstanceId);
    try {
      return JSON.stringify(
        await this.cells.run(
          socket,
          clientInstanceId,
          chatId,
          toolCallId,
          targets,
          this.namedCell(chatId, input),
          signal,
        ),
      );
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }
  }
  private pickCodeClient(chatId: string): { clientInstanceId?: string; available: string[] } {
    const associated = [...(this.associations.get(chatId)?.values() ?? [])].map((a) => a.target);
    const available = [...this.codeClients].filter((id) => this.isInstanceAvailable(id));
    const preferred = associated
      .map((target) => target.clientInstanceId)
      .find((id) => available.includes(id));
    return {
      available,
      ...(preferred
        ? { clientInstanceId: preferred }
        : available.length === 1
          ? { clientInstanceId: available[0] }
          : {}),
    };
  }
  private codeUnavailable(available: string[]): string {
    return JSON.stringify({
      error: available.length ? "AMBIGUOUS_BROWSER" : "BROWSER_OFFLINE",
      detail: available.length
        ? "Several browsers are connected; attach a tab from the intended browser first."
        : "No connected browser can run browser_code. Reload Aeon in chrome://extensions.",
    });
  }
  private namedCell(chatId: string, input: BrowserCodeCellInput): BrowserCodeCellInput {
    const title = input.ownerTitle ?? this.ownerTitles?.(chatId);
    const space = input.space ?? this.spaceForChat?.(chatId);
    return title || space
      ? { ...input, ...(title ? { ownerTitle: title } : {}), ...(space ? { space } : {}) }
      : input;
  }
  /** After a stop (or a daemon restart), close the tabs a finished run no longer needs. */
  tidyChat(chatId: string): void {
    for (const socket of this.executors.values())
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ kind: "browser.release", chatId, reset: false, tidy: true }));
  }
  /** One daemon start: tidying is safe only for runs this process never had. */
  tidyOnStartup(clientInstanceId: string, socket: WebSocket): void {
    if (!this.startupTidy || this.startupTidied.has(clientInstanceId)) return;
    this.startupTidied.add(clientInstanceId);
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ kind: "browser.tidy" }));
  }
  /** Production calls this once; a bare service in tests leaves executors untouched. */
  enableStartupTidy(): void {
    this.startupTidy = true;
  }
  /** The sockets of the connected browsers, for messages every browser answers on its own. */
  executorSockets(): WebSocket[] {
    return [...this.executors.values()];
  }
  /** Starts or reports the daemon CDP endpoint; calls travel over the existing executor socket. */
  async startCdp(port: number, directory: string): Promise<unknown> {
    this.cdpService ??= new CdpService((body) => this.sendCdp(body), directory);
    return this.cdpService.start(port);
  }
  cdpStatus(): Promise<unknown> {
    return this.cdpService?.status() ?? Promise.resolve({ running: false });
  }
  stopCdp(): Promise<unknown> {
    return this.cdpService?.stop() ?? Promise.resolve({ running: false });
  }
  private sendCdp(body: Record<string, unknown>): void {
    const socket = [...this.executors.values()].find((item) => item.readyState === WebSocket.OPEN);
    if (!socket) throw new Error("BROWSER_OFFLINE: no browser connected");
    socket.send(JSON.stringify(body));
  }
  /** Ask every connected browser to show a chat as a tab; returns how many were asked. */
  openChatTab(chatId: string, active = false): number {
    let asked = 0;
    for (const socket of this.executors.values())
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ kind: "native.chat.open", chatId, active }));
        asked++;
      }
    return asked;
  }
  private release(chatId: string, reset = false, tidy = false): void {
    for (const pending of this.pending.values())
      if (pending.chatId === chatId) pending.finish(undefined, "RUN_RESET");
    for (const socket of this.executors.values())
      if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({ kind: "browser.release", chatId, reset, ...(tidy ? { tidy } : {}) }),
        );
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
    const title = step.ownerTitle ?? this.ownerTitles?.(chatId);
    const space = step.space ?? this.spaceForChat?.(chatId);
    const named = {
      ...step,
      ...(title ? { ownerTitle: title } : {}),
      ...(space ? { space } : {}),
    };
    const opened = await this.dispatch(socket, chatId, toolCallId, operationId, named, timeoutMs);
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
  private outdatedRuntime(
    step: Exclude<BrowserStep, { op: "listTabs" | "openTab" | "attachTab" }>,
  ): { code: string; detail: string } | undefined {
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
    return undefined;
  }
  private async executeTargetedStep(
    chatId: string,
    toolCallId: string,
    operationId: string,
    step: Exclude<BrowserStep, { op: "listTabs" | "openTab" | "attachTab" }>,
    timeoutMs: number,
  ): Promise<{ result?: BrowserExecutorResult; code?: string; detail?: string }> {
    const outdated = this.outdatedRuntime(step);
    if (outdated) return outdated;
    if (!this.getAssociation(chatId, step.target)) return { code: "TARGET_LOST" };
    const tab = this.inventories?.findTarget(step.target);
    if (!tab || !safeUrl(tab.url)) return { code: "TARGET_LOST" };
    const socket = this.executors.get(step.target.clientInstanceId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return { code: "BROWSER_OFFLINE" };
    // Polling an event subscription only reads its buffer, so it neither takes nor waits for the
    // tab's claim (a long poll would otherwise block every action on the tab).
    if (step.op === "event" && step.action !== "subscribe")
      return this.dispatch(
        socket,
        chatId,
        toolCallId,
        operationId,
        step,
        timeoutMs,
        randomUUID(),
        Math.max(1, this.claimGeneration),
        tab.documentEpoch,
      );
    if (!isWriteStep(step))
      return this.dispatch(
        socket,
        chatId,
        toolCallId,
        operationId,
        step,
        timeoutMs,
        undefined,
        undefined,
        tab.documentEpoch,
      );
    return this.claimedDispatch(
      socket,
      chatId,
      toolCallId,
      operationId,
      step,
      timeoutMs,
      tab.documentEpoch,
    );
  }

  private async claimedDispatch(
    socket: WebSocket,
    chatId: string,
    toolCallId: string,
    operationId: string,
    step: Exclude<BrowserStep, { op: "listTabs" | "openTab" | "attachTab" }>,
    timeoutMs: number,
    documentEpoch: number,
  ): Promise<{ result?: BrowserExecutorResult; code?: string; detail?: string }> {
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
        documentEpoch,
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
  /**
   * The chat's tabs that still exist, newest last, at most the protocol's 64. Closed tabs are
   * forgotten here: a long session must never fill the list with tabs that are gone.
   */
  private liveTargets(chatId: string): BrowserTargetKey[] {
    const byTarget = this.associations.get(chatId);
    if (!byTarget) return [];
    const inventories = this.inventories;
    // A tab is gone only when its browser's tab list is known and no longer has it.
    if (inventories)
      for (const [key, { target }] of byTarget)
        if (inventories.get(target.clientInstanceId) && !inventories.findTarget(target))
          byTarget.delete(key);
    return [...byTarget.values()].map((a) => a.target).slice(-64);
  }
  private getAssociation(chatId: string, target: BrowserTargetKey): Association | undefined {
    const association = this.associations.get(chatId)?.get(targetIdentity(target));
    return association && sameTarget(association.target, target) ? association : undefined;
  }
}

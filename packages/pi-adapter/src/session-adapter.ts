import { findDetachedFork, inspectForkEntry } from "./session-detached-fork.js";
import { setInitialModel, verifyCachedHandle } from "./session-initial-model.js";
import { PreparedModelRuntime } from "./prepared-model-runtime.js";
import { startupTiming, timeStartupStep } from "./startup-timing.js";
import { PreparedSessionResources } from "./prepared-session-resources.js";
import { installBrowserControlRequestProjection } from "./browser-provider-projection.js";
import { waitForMcpConnectionState } from "./session-mcp-status.js";
import {
  SessionManager,
  VERSION,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type OpenPiSessionInput,
  type PiSessionHandle,
  type PiModelCatalog,
  type PiMcpServerStatus,
  type PiSessionPort,
  type PiSessionReference,
  type PiTranscriptMatch,
  PiForkUnsupportedEntryError,
  type PiForkEntryCheck,
} from "@aeon/domain";
import { createThreadTools, type ThreadToolHost } from "./thread-tools.js";
import { createLocalFixtureModel, fixtureSessionOptions } from "./fixture-model.js";
import { readCachedPiModelCatalog } from "./session-model-catalog.js";
import { wrapPiSession } from "./session-projection.js";
import { searchTranscript } from "./transcript-search.js";
import {
  resolvePiSessionManager,
  sessionReferenceFromManager,
  storedThinkingLevel,
} from "./session-resolver.js";
import type { BrowserToolRunner } from "./browser-tool.js";
import { createBrowserTools } from "./browser-code-tool.js";
import { createClockTool } from "./clock-tool.js";
import { installBrowserSessionLifecycle } from "./browser-session-lifecycle.js";
import { createCapabilityTools, type CapabilityToolHost } from "./capability-tools.js";
import { ExtensionUiBridge } from "./extension-ui-bridge.js";
import { bindPiExtensions } from "./sdk-resources.js";

export interface PiSdkSessionAdapterOptions {
  sessionDirectory: string;
  agentDirectory?: string;
  testModel?: "local-faux";
  preferredInitialModel?: { provider: string; id: string };
  browserTool?: BrowserToolRunner;
  capabilityToolHost?: CapabilityToolHost;
}

export class PiSdkSessionAdapter implements PiSessionPort {
  private readonly sessionDirectory: string;
  private readonly agentDirectory: string | undefined;
  private readonly testModel: "local-faux" | undefined;
  private readonly preferredInitialModel: { provider: string; id: string } | undefined;
  private readonly browserTool: BrowserToolRunner | undefined;
  private capabilityToolHost: CapabilityToolHost | undefined;
  private threadToolHost: ThreadToolHost | undefined;
  private readonly liveSessions = new Map<string, Promise<PiSessionHandle>>();
  private readonly pendingResourceReloads = new Set<string>();
  private readonly preparedRuntime: PreparedModelRuntime | undefined;
  private readonly resources: PreparedSessionResources;

  constructor(options: PiSdkSessionAdapterOptions) {
    this.sessionDirectory = resolve(options.sessionDirectory);
    this.agentDirectory = options.agentDirectory ? resolve(options.agentDirectory) : undefined;
    this.testModel = options.testModel;
    this.preferredInitialModel = options.preferredInitialModel;
    this.browserTool = options.browserTool;
    this.capabilityToolHost = options.capabilityToolHost;
    this.resources = new PreparedSessionResources(
      this.agentDirectory ?? resolvePiAgentDirectory(),
      Boolean(this.browserTool),
    );
    if (this.testModel && !this.agentDirectory) {
      throw new Error("The local faux model requires a separate, explicit Pi agent directory.");
    }
    this.preparedRuntime = this.testModel
      ? undefined
      : new PreparedModelRuntime(this.agentDirectory ?? resolvePiAgentDirectory());
  }

  openOrCreate(input: OpenPiSessionInput): Promise<PiSessionHandle> {
    const current = this.liveSessions.get(input.chatId);
    if (current) return current.then((handle) => verifyCachedHandle(handle, input));
    if (VERSION !== "0.99.1") throw new Error(`Unsupported Pi SDK version ${VERSION}.`);

    const startedAt = Date.now();
    const opening: Promise<PiSessionHandle> = this.createHandle(input).then((handle) => {
      startupTiming("session-ready", startedAt);
      return this.cacheAwareHandle(handle, input.chatId, opening);
    });
    this.liveSessions.set(input.chatId, opening);
    return opening.catch((error: unknown) => {
      if (this.liveSessions.get(input.chatId) === opening) this.liveSessions.delete(input.chatId);
      throw error;
    });
  }

  getModelCatalog(): Promise<PiModelCatalog> {
    this.preparedRuntime?.prepare();
    return readCachedPiModelCatalog(this, {
      sessionDirectory: this.sessionDirectory,
      agentDirectory: this.agentDirectory,
      testModel: this.testModel,
      preferredInitialModel: this.preferredInitialModel,
    });
  }

  prepareResources(workingDirectory: string): Promise<void> {
    this.preparedRuntime?.prepare();
    return this.resources.prepare(workingDirectory);
  }

  async searchTranscript(
    reference: PiSessionReference,
    workingDirectory: string,
    query: string,
  ): Promise<PiTranscriptMatch | undefined> {
    return searchTranscript(this.sessionDirectory, reference, workingDirectory, query);
  }

  setThreadToolHost(host: ThreadToolHost): void {
    this.threadToolHost = host;
  }

  setCapabilityToolHost(host: CapabilityToolHost): void {
    this.capabilityToolHost = host;
  }

  async forkFromEntry(input: {
    reference: PiSessionReference;
    workingDirectory: string;
    entryId: string;
    targetChatId: import("@aeon/domain").ChatId;
  }): Promise<PiSessionReference> {
    const check = this.inspectForkEntry(input);
    if (!check.supported && check.reason === "entry_not_found")
      throw new Error("The requested Pi fork entry does not exist.");
    if (!check.supported) throw new PiForkUnsupportedEntryError();
    const targetDirectory = this.forkDirectory(input.targetChatId);
    const source = SessionManager.open(
      input.reference.sessionFile,
      targetDirectory,
      input.workingDirectory,
    );
    mkdirSync(targetDirectory, { recursive: true });
    const forkPath = source.createBranchedSession(input.entryId);
    if (!forkPath) throw new Error("Pi did not create a persistent detached fork.");
    if (!existsSync(forkPath))
      throw new Error(
        "Pi deferred fork persistence because the selected branch has no assistant entry.",
      );
    const fork = SessionManager.open(forkPath, targetDirectory, input.workingDirectory);
    if (fork.getHeader()?.parentSession !== resolve(input.reference.sessionFile))
      throw new Error("Pi fork parent provenance does not match the selected source session.");
    if (fork.getLeafId() !== input.entryId)
      throw new Error("Pi fork did not preserve the requested transcript entry as its leaf.");
    return { sessionId: fork.getSessionId(), sessionFile: forkPath };
  }

  inspectForkEntry(input: {
    reference: PiSessionReference;
    workingDirectory: string;
    entryId: string;
  }): PiForkEntryCheck {
    return inspectForkEntry(input);
  }

  findDetachedFork(input: {
    sourceReference: PiSessionReference;
    workingDirectory: string;
    entryId: string;
    targetChatId: import("@aeon/domain").ChatId;
  }): import("@aeon/domain").PiDetachedForkEvidence {
    return findDetachedFork(this.sessionDirectory, input);
  }

  async closeAll(): Promise<void> {
    this.resources.clear();
    this.preparedRuntime?.close();
    const pendingSessions = [...this.liveSessions.values()];
    this.liveSessions.clear();
    await Promise.all(pendingSessions.map(async (pending) => (await pending).close()));
  }

  async reloadAllResources(): Promise<void> {
    this.resources.clear();
    const chats = [...this.liveSessions.entries()];
    await Promise.all(
      chats.map(async ([chatId, pending]) => {
        const handle = await pending;
        if (handle.snapshot().active || handle.snapshot().runState === "needs_attention") {
          this.pendingResourceReloads.add(chatId);
          return;
        }
        await handle.reloadResources();
        this.pendingResourceReloads.delete(chatId);
      }),
    );
  }

  async reloadChatResources(chatId: string): Promise<{
    statuses: readonly PiMcpServerStatus[];
    deferred: boolean;
  }> {
    const pending = this.liveSessions.get(chatId);
    if (!pending) return { statuses: [], deferred: false };
    const handle = await pending;
    if (handle.snapshot().active || handle.snapshot().runState === "needs_attention") {
      this.pendingResourceReloads.add(chatId);
      return { statuses: handle.effectiveResources().mcpServers, deferred: true };
    }
    await handle.reloadResources();
    this.pendingResourceReloads.delete(chatId);
    return { statuses: await waitForMcpConnectionState(handle), deferred: false };
  }

  async getChatMcpStatuses(chatId: string): Promise<readonly PiMcpServerStatus[] | undefined> {
    const pending = this.liveSessions.get(chatId);
    if (!pending) return undefined;
    return (await pending).effectiveResources().mcpServers;
  }

  private async createHandle(input: OpenPiSessionInput): Promise<PiSessionHandle> {
    const manager = resolvePiSessionManager(input, this.sessionDirectory);
    const thinkingLevel = storedThinkingLevel(manager);
    const [{ resourceLoader, settingsManager, getMcpServers }, modelRuntime] = await Promise.all([
      this.resources.take(input.workingDirectory),
      this.preparedRuntime?.take(),
    ]);
    const fixture =
      this.testModel && this.agentDirectory
        ? await createLocalFixtureModel(this.agentDirectory)
        : undefined;
    const options = {
      cwd: input.workingDirectory,
      agentDir: this.agentDirectory ?? resolvePiAgentDirectory(),
      settingsManager,
      resourceLoader,
      sessionManager: manager,
      ...(modelRuntime ? { modelRuntime } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...fixtureSessionOptions(fixture),
      customTools: [
        ...createBrowserTools(
          input.chatId,
          this.browserTool,
          input.workingDirectory,
          resolve(this.sessionDirectory, "..", "site-skills"),
        ),
        ...createThreadTools(input.chatId, this.threadToolHost),
        ...createCapabilityTools(input.chatId, this.capabilityToolHost),
        createClockTool(),
      ],
    };
    const { session } = await timeStartupStep("agent-session-created", () =>
      createAgentSession(options),
    );
    installBrowserSessionLifecycle(session, input.chatId, this.browserTool);
    await setInitialModel(session, input, this.preferredInitialModel, fixture);
    const reference = sessionReferenceFromManager(manager);
    if (reference.sessionId !== input.activationId) {
      session.dispose();
      throw new Error("Pi restored a session that does not match the durable activation ID.");
    }
    installBrowserControlRequestProjection(session);
    const extensionUi = new ExtensionUiBridge(session);
    try {
      await timeStartupStep("extensions-bound", () =>
        bindPiExtensions(session, extensionUi.context),
      );
    } catch (error) {
      extensionUi.close();
      session.dispose();
      throw error;
    }
    return wrapPiSession(session, manager, reference, input.chatId, extensionUi, getMcpServers);
  }

  private cacheAwareHandle(
    handle: PiSessionHandle,
    chatId: string,
    opening: Promise<PiSessionHandle>,
  ): PiSessionHandle {
    const close = handle.close.bind(handle);

    const unsubscribe = handle.subscribe((event) => {
      if (event.kind !== "run-state" && event.kind !== "extension-ui-resolved") return;
      if (!this.pendingResourceReloads.has(chatId)) return;
      queueMicrotask(() => {
        const current = cached;
        if (!current || this.liveSessions.get(chatId) !== opening) return;
        const snapshot = current.snapshot();
        if (snapshot.active || snapshot.runState === "needs_attention") return;
        if (!this.pendingResourceReloads.delete(chatId)) return;
        void current.reloadResources().catch(() => this.pendingResourceReloads.add(chatId));
      });
    });
    const cached: PiSessionHandle = {
      ...handle,
      close: async () => {
        await this.browserTool?.(chatId, "browser-session-cleanup", { release: true, reset: true });
        unsubscribe();
        this.pendingResourceReloads.delete(chatId);
        if (this.liveSessions.get(chatId) === opening) this.liveSessions.delete(chatId);
        await close();
      },
    };
    return cached;
  }

  private forkDirectory(targetChatId: string): string {
    return join(this.sessionDirectory, "detached-forks", targetChatId);
  }
}

export function resolvePiAgentDirectory(): string {
  return resolve(getAgentDir());
}

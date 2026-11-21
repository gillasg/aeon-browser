import { randomUUID } from "node:crypto";
import { configureSiteRequests } from "./site-requests.js";
import { PinnedResults } from "./pinned-results.js";
import { CoreAttention } from "./core-attention.js";
import { installChatPreparation, warmAfterReady } from "./chat-preparation.js";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatService } from "./chat-service.js";
import {
  browserNamedFor,
  browserParentChat,
  createAeonHostHandler,
  PiSdkSessionAdapter,
  resolvePiAgentDirectory,
  sessionChatId,
  siteMapperRequest,
  siteToolModel,
} from "@aeon/pi-adapter";
import { openChatStore } from "@aeon/store";
import { SiteScriptService } from "./site-script-service.js";
import { browserControlFor } from "./password-saving-sync.js";
import { BrowserControlService } from "./browser-control-service.js";
import { ThreadCoordinationService } from "./thread-coordination-service.js";
import { CapabilityRegistry } from "./capability-registry.js";
import { RoutineScheduler } from "./routine-scheduler.js";
import { BrowserSiteRules } from "./browser-site-rules.js";
import { type ActivityCounts } from "./daemon-activity.js";
import { readPasswordManagerStatus } from "./password-manager-status.js";
import { chatBrowserName, pin, pinInherited } from "./core-browsers.js";
import {
  abilityCards,
  lastActionNote,
  providerCards,
  runningWorkflowCount,
  siteCards,
  workflowCards,
} from "./management-library.js";
import { LibraryActions, isLibraryAction } from "./library-actions.js";
import { CapabilityToolService } from "./capability-tool-service.js";
import { PiMcpConfigMigration } from "./pi-mcp-config-migration.js";
import { piMcpServerName } from "./mcp-registry-mapping.js";
import { readEnvironment } from "./environment.js";
import { backfillChatOrigins } from "./chat-origin-backfill.js";
import { migrateAeonSettings } from "./settings-migration.js";
import { outsideContextAnswer, type OutsideTab } from "./outside-context.js";
import { listSites, migrateAllAbilities } from "@browserkit/site-mapper";
import { siteCounts } from "./site-counts.js";
import { McpClientManager } from "./mcp-client-manager.js";
import { McpCodeBridge } from "./mcp-code-bridge.js";
import { AbilityIdleWorker, IDLE_SESSION, idleCodeCell } from "./ability-idle-worker.js";

export function createProductionRuntime(dataDirectory: string): {
  service: ChatService;
  attention: CoreAttention;
  threadCoordination: ThreadCoordinationService;
  browserControl: BrowserControlService;
  ready: Promise<void>;
  /** Chats, routines, cells and abilities still running. `aeon update` polls this. */
  activity(): ActivityCounts;
  /** Warms the next chat's resources once the daemon answers (see warmAfterReady). */
  warm(): void;
  close(): Promise<void>;
} {
  const dataRoot = resolve(dataDirectory);
  const store = openChatStore(dataRoot);
  const registry = new CapabilityRegistry(join(dataRoot, "capabilities.json"), store);
  const piAgentDirectory = resolvePiAgentDirectory();
  const mcpMigration = new PiMcpConfigMigration({
    dataDirectory: dataRoot,
    legacyRegistryPath: join(dataRoot, "capabilities.json"),
    piAgentDirectory,
    defaultWorkingDirectory: process.cwd(),
    cliBridge: {
      command: process.execPath,
      scriptPath: fileURLToPath(new URL("./cli-mcp-bridge.js", import.meta.url)),
      registryPath: join(dataRoot, "capabilities.json"),
    },
  });
  const browserControl = browserControlFor(dataRoot);
  const siteScripts = attachSiteScripts(dataRoot, browserControl);
  const pi = createPiAdapter(dataRoot, piAgentDirectory, browserControl);
  // browser_code reaches the chat's connected MCP tools through this bridge: sandbox -> daemon ->
  // McpClientManager.callMcpTool. Only MCP capabilities are listed, never Aeon's own browser tools.
  pi.setMcpBridge(new McpCodeBridge(new McpClientManager(registry)));
  warmModels(pi);
  const siteRules = new BrowserSiteRules();
  const service = new ChatService({ dataDirectory: dataRoot, store, pi, siteRules });
  bindChatService(service, browserControl, store, dataRoot);
  pi.setSiteRulesHost((chatId) => siteRules.answer(chatId));
  pi.setBrowserNameHost((chatId) => chatBrowserName(dataRoot, browserControl, chatId));
  const stopPreparing = installChatPreparation(service);
  const attention = new CoreAttention(dataRoot, service);
  configureSiteRequests(dataRoot);
  const pins = new PinnedResults(dataRoot);
  const threadCoordination = new ThreadCoordinationService(service, store);
  const routines = new RoutineScheduler(store, service, browserControl);
  routines.onAlert = (chatId, title, message) => attention.alert(chatId, title, message);
  routines.onCheck = (routine, check) => void pins.recordCheck(routine, check);
  const capabilityTools = new CapabilityToolService(
    registry,
    mcpMigration,
    pi,
    store,
    routines,
    pins,
  );
  pi.setThreadToolHost(threadCoordination);
  pi.setCapabilityToolHost(capabilityTools);
  installManagementActions(service, browserControl, capabilityTools, dataRoot);
  const idleAbilities = installAbilityIdle({
    attention,
    routines,
    siteRules,
    browserControl,
    dataRoot,
    piAgentDirectory,
  });
  installManagementReaders(service, store, capabilityTools, pins, dataRoot);
  const ready = runtimeReady(
    idleAbilities,
    registry,
    mcpMigration,
    threadCoordination,
    routines,
    pins,
    service,
    store,
    dataRoot,
  );
  return {
    service,
    attention,
    threadCoordination,
    browserControl,
    ready,
    activity: () => readDaemonActivity(attention, routines, siteRules, browserControl),
    warm: () => warmAfterReady(service),
    close: async () => {
      stopPreparing();
      idleAbilities.close();
      await attention.close();
      routines.close();
      pins.close();
      threadCoordination.close();
      await pi.closeAll();
      siteScripts.close();
      closeRuntimeStores(service, store);
    },
  };
}

function bindChatService(
  service: ChatService,
  browserControl: BrowserControlService,
  store: ReturnType<typeof openChatStore>,
  dataRoot: string,
): void {
  service.setStoppedListener((chatId) => browserControl.tidyChat(chatId));
  bindChatLabels(browserControl, store);
  service.setExternalContextReader(() =>
    outsideContextAnswer(dataRoot, () => readOpenTabs(browserControl)),
  );
  service.setBrowserResolver((name, chatId) =>
    resolveNamedBrowser(browserControl, dataRoot, name, chatId),
  );
}

async function resolveNamedBrowser(
  browser: BrowserControlService,
  directory: string,
  name: string,
  chatId: string,
): Promise<string> {
  await pin(browser, directory, chatId, name);
  const id = browser.browserOf(chatId);
  if (!id) throw new Error(`No connected browser is named ${name}.`);
  return id;
}

function bindChatLabels(
  browser: BrowserControlService,
  store: ReturnType<typeof openChatStore>,
): void {
  browser.useOwnerTitles((chatId) => ownerTitle(store, chatId));
  browser.useDefaultSpaces((chatId) => defaultSpace(store, chatId));
}

function ownerTitle(store: ReturnType<typeof openChatStore>, chatId: string): string | undefined {
  const chat = store.getChat(chatId as import("@aeon/domain").ChatId);
  if (!chat) return undefined;
  const title = chat.title.trim().slice(0, 80) || "Chat";
  return chat.origin === "routine" ? `Routine · ${title}` : title;
}

/** Agent chats stay in the user's window. Routines and outside sessions get their own window. */
function defaultSpace(store: ReturnType<typeof openChatStore>, chatId: string): "window" | "tabs" {
  const chat = store.getChat(chatId as import("@aeon/domain").ChatId);
  if (!chat) return "window";
  return ["user", "agent", "cli", "mcp"].includes(chat.origin) ? "tabs" : "window";
}

function readDaemonActivity(
  attention: CoreAttention,
  routines: RoutineScheduler,
  siteRules: BrowserSiteRules,
  browser: BrowserControlService,
): ActivityCounts {
  return {
    workingChats: attention.workingCount(),
    askingChats: attention.askingCount(),
    routines: Math.max(routines.busyCount(), siteRules.activeRoutineCount()),
    cells: browser.activeCellCount(),
    abilities: runningWorkflowCount(),
  };
}

async function migrateAbilitiesOnStartup(dataRoot: string): Promise<void> {
  await migrateAllAbilities({ skillsDirectory: join(dataRoot, "site-skills") }).catch(
    () => undefined,
  );
}

async function readManagementSnapshot(
  service: ChatService,
  store: ReturnType<typeof openChatStore>,
  capabilityTools: CapabilityToolService,
  pins: PinnedResults,
  dataDirectory: string,
  selectedChatId?: import("@aeon/domain").ChatId,
): Promise<unknown> {
  let resources = null;
  let resourceError: string | null = null;
  if (selectedChatId) {
    try {
      resources = await service.getEffectiveResources(selectedChatId);
    } catch (error) {
      resourceError = error instanceof Error ? error.message.slice(0, 300) : "Pi is unavailable.";
    }
  }
  const routines = managementRoutines(service, store);
  const catalog = (await capabilityTools.readManagementCatalog()) as {
    revision: number;
    capabilities: Array<Record<string, unknown>>;
  };
  const capabilities = catalog.capabilities.map((capability) => {
    if (capability.kind !== "mcp") return capability;
    if (!resources || resources.sessionState !== "loaded")
      return {
        ...capability,
        connectionState: "not_reported",
        loadedInSelectedChat: null,
      };
    const id = typeof capability.id === "string" ? capability.id : "";
    const status = id
      ? resources.mcpServers.find(({ name }) => name === piMcpServerName(id))
      : undefined;
    return {
      ...capability,
      connectionState: status?.state ?? "not_configured",
      loadedInSelectedChat: status !== undefined,
    };
  });
  return {
    chats: service.listChats(100),
    routines,
    pins: await pins.list(),
    capabilityRevision: catalog.revision,
    capabilities,
    resources,
    resourceError,
    signIn: await readPasswordManagerStatus(),
    // The Automations and Sites pages: site abilities, and mapped sites with health and a
    // stored session. They read the shared browserkit folders.
    abilities: await abilityCards(),
    workflows: await workflowCards(),
    sites: await siteCards(),
    providers: providerCards(),
    lastAction: lastActionNote(),
  };
}

async function readHomeManagementSnapshot(
  service: ChatService,
  store: ReturnType<typeof openChatStore>,
): Promise<unknown> {
  const all = store.listRoutines();
  return {
    sites: siteCounts(await listSites().catch(() => []), all),
    routines: all
      .filter((routine) => !routine.deletedAt)
      .slice(0, 3)
      .map((routine) => ({
        routineId: routine.routineId,
        chatId: routine.chatId,
        chatTitle: service.getChat(routine.chatId)?.title ?? "Unavailable Chat",
        title: routine.title,
        nextDueAt: routine.nextDueAt,
        enabled: routine.enabled,
      })),
  };
}

async function initializeRuntime(
  registry: CapabilityRegistry,
  migration: PiMcpConfigMigration,
  threads: ThreadCoordinationService,
  routines: RoutineScheduler,
  pins: PinnedResults,
  service: ChatService,
  store: ReturnType<typeof openChatStore>,
  dataRoot: string,
): Promise<void> {
  await migrateAeonSettings(dataRoot);
  await backfillChatOrigins(store, dataRoot);
  await registry.initialize();
  await migration.migrate(await registry.snapshot());
  await threads.recover();
  await routines.start();
  await pins.start();
}

function managementRoutines(
  service: ChatService,
  store: ReturnType<typeof openChatStore>,
): unknown {
  return store
    .listRoutines()
    .filter((routine) => !routine.deletedAt)
    .slice(0, 100)
    .map((routine) => ({
      routineId: routine.routineId,
      chatId: routine.chatId,
      chatTitle: service.getChat(routine.chatId)?.title ?? "Unavailable Chat",
      title: routine.title,
      instruction: routine.instruction,
      schedule: routine.schedule,
      ...(routine.check || routine.checkShell ? { checks: true } : {}),
      ...(routine.check?.includes("browser.snipe(") ? { kind: "snipe" as const } : {}),
      ...(routine.checkShell ? { checkShell: routine.checkShell } : {}),
      ...(routine.listen ? { listen: routine.listen } : {}),
      sites: routine.sites,
      nextDueAt: routine.nextDueAt,
      requiredBrowserInstanceId: routine.requiredBrowserInstanceId,
      enabled: routine.enabled,
      revision: routine.revision,
      recentRuns: store.listRoutineRuns(routine.routineId, 10).map((run) => ({
        runId: run.runId,
        scheduledSlot: run.scheduledSlot,
        manual: run.manual,
        state: run.state,
        piEntryId: run.piEntryId,
        createdAt: run.createdAt,
        completedAt: run.completedAt,
        lastError: run.lastError?.slice(0, 500) ?? null,
      })),
    }));
}

function warmModels(pi: PiSdkSessionAdapter): void {
  const startedAt = Date.now();
  void pi
    .getModelCatalog()
    .then(() =>
      process.stderr.write(
        JSON.stringify({
          kind: "core.startup-timing",
          phase: "model-catalog-ready",
          durationMs: Date.now() - startedAt,
        }) + "\n",
      ),
    )
    .catch((error) => process.stderr.write("Aeon model warmup failed: " + String(error) + "\n"));
}

function closeRuntimeStores(service: ChatService, store: ReturnType<typeof openChatStore>): void {
  service.projects.close();
  store.close();
}

async function readOpenTabs(browser: BrowserControlService): Promise<OutsideTab[]> {
  const raw = await browser.execute(sessionChatId("external", "context"), "context-tool", {
    codeCell: {
      code: "const tabs = await browser.tabs(); tabs.map((tab) => ({ title: tab.title, url: tab.url, active: tab.active === true }))",
      timeoutMs: 10_000,
      onCall: () => Promise.resolve({ error: "UNSUPPORTED" }),
      onProgress: () => undefined,
    },
  });
  const cell = JSON.parse(raw) as { value?: OutsideTab[]; error?: string; detail?: string };
  if (cell.error) throw new Error(cell.detail ? `${cell.error}: ${cell.detail}` : cell.error);
  return Array.isArray(cell.value) ? cell.value : [];
}

function attachSiteScripts(directory: string, browser: BrowserControlService): SiteScriptService {
  const scripts = new SiteScriptService(directory, browser);
  browser.useSiteScripts(scripts);
  return scripts;
}

function createPiAdapter(
  dataRoot: string,
  piAgentDirectory: string,
  browserControl: BrowserControlService,
): PiSdkSessionAdapter {
  const pi = new PiSdkSessionAdapter({
    sessionDirectory: join(dataRoot, "pi-sessions"),
    agentDirectory: piAgentDirectory,
    preferredInitialModel: {
      provider:
        process.env.AEON_INITIAL_MODEL_PROVIDER ||
        process.env.PIPPIN_INITIAL_MODEL_PROVIDER ||
        "opencode-go",
      id: readEnvironment("INITIAL_MODEL_ID") || "deepseek-v4.1-flash",
    },
    browserTool: (chatId, toolCallId, input, signal) =>
      pinInherited(
        browserControl,
        dataRoot,
        chatId,
        browserParentChat(),
        browserNamedFor(chatId),
      ).then(() => browserControl.execute(chatId, toolCallId, input, signal)),
  });
  return pi;
}

function installManagementReaders(
  service: ChatService,
  store: ReturnType<typeof openChatStore>,
  capabilityTools: CapabilityToolService,
  pins: PinnedResults,
  dataDirectory: string,
): void {
  service.management.setReader((selectedChatId) =>
    readManagementSnapshot(service, store, capabilityTools, pins, dataDirectory, selectedChatId),
  );
  service.management.setHomeReader(() => readHomeManagementSnapshot(service, store));
}

function runtimeReady(
  idle: AbilityIdleWorker,
  ...args: Parameters<typeof initializeRuntime>
): Promise<void> {
  return initializeRuntime(...args).then(async () => {
    await migrateAbilitiesOnStartup(args[7]);
    idle.start();
  });
}

/** Idle ability repair: hidden cells, no site writes, stops the moment anything is busy. */
function installAbilityIdle(options: {
  attention: CoreAttention;
  routines: RoutineScheduler;
  siteRules: BrowserSiteRules;
  browserControl: BrowserControlService;
  dataRoot: string;
  piAgentDirectory: string | undefined;
}): AbilityIdleWorker {
  const { attention, routines, siteRules, browserControl, dataRoot, piAgentDirectory } = options;
  return new AbilityIdleWorker({
    activity: () => readDaemonActivity(attention, routines, siteRules, browserControl),
    cell: async (code) => {
      const chatId = sessionChatId("external", IDLE_SESSION);
      const host = createAeonHostHandler({
        source: "external",
        siteRules: () => siteRules.answer(chatId),
        siteMapper: (request) => siteMapperRequest(chatId, request),
      });
      let output: string;
      try {
        output = await browserControl.execute(chatId, `ability-idle-${randomUUID()}`, {
          codeCell: idleCodeCell(
            code,
            (request: Record<string, unknown>) =>
              host(request, { source: "external", scope: chatId }) ??
              Promise.resolve({ error: "UNSUPPORTED" }),
          ),
        });
      } finally {
        // A check keeps no tabs: close whatever it opened, even when it failed.
        browserControl.tidyChat(chatId);
      }
      const parsed = JSON.parse(output) as { value?: unknown; error?: string };
      if (parsed.error) throw new Error(parsed.error);
      return parsed.value;
    },
    model: siteToolModel({
      sessionDirectory: dataRoot,
      agentDirectory: piAgentDirectory,
      preferredInitialModel: undefined,
    }),
  });
}

function installManagementActions(
  service: ChatService,
  browserControl: BrowserControlService,
  capabilityTools: CapabilityToolService,
  dataDirectory: string,
): void {
  // Workflow and site actions run browser cells through this daemon; routine and capability
  // actions stay with the capability service.
  const library = new LibraryActions(async (code, options = {}) => {
    const session = options.session ?? "management";
    const chatId = sessionChatId("external", session);
    const host = createAeonHostHandler({
      source: "external",
      siteMapper: (request) => siteMapperRequest(chatId, request),
    });
    const output = await browserControl.execute(chatId, `management-${randomUUID()}`, {
      codeCell: {
        code,
        timeoutMs: options.timeoutMs ?? 60_000,
        ownerTitle: `Management - ${session}`,
        onCall: (request: Record<string, unknown>) =>
          host(request, { source: "external", scope: chatId }) ??
          Promise.resolve({ error: "UNSUPPORTED" }),
        onProgress: () => undefined,
      },
    });
    const parsed = JSON.parse(output) as { value?: unknown; error?: string };
    if (parsed.error) throw new Error(parsed.error);
    return parsed.value;
  }, dataDirectory);
  service.management.setActionRunner((chatId, action, input) =>
    isLibraryAction(action)
      ? library.execute(action, input, chatId)
      : capabilityTools.executeManagementAction(chatId, action, input),
  );
}

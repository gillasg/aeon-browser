import { CoreAttention } from "./core-attention.js";
import { installChatPreparation, prepareChat } from "./chat-preparation.js";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatService } from "./chat-service.js";
import { PiSdkSessionAdapter, resolvePiAgentDirectory } from "@aeon/pi-adapter";
import { openChatStore } from "@aeon/store";
import { SiteScriptService } from "./site-script-service.js";
import { BrowserControlService } from "./browser-control-service.js";
import { ThreadCoordinationService } from "./thread-coordination-service.js";
import { CapabilityRegistry } from "./capability-registry.js";
import { RoutineScheduler } from "./routine-scheduler.js";
import { CapabilityToolService } from "./capability-tool-service.js";
import { PiMcpConfigMigration } from "./pi-mcp-config-migration.js";
import { piMcpServerName } from "./mcp-registry-mapping.js";
import { readEnvironment } from "./environment.js";

export function createProductionRuntime(dataDirectory: string): {
  service: ChatService;
  attention: CoreAttention;
  threadCoordination: ThreadCoordinationService;
  browserControl: BrowserControlService;
  ready: Promise<void>;
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
  const browserControl = new BrowserControlService();
  const siteScripts = attachSiteScripts(dataRoot, browserControl);
  const pi = createPiAdapter(dataRoot, piAgentDirectory, browserControl);
  warmModels(pi);
  const service = new ChatService({ dataDirectory: dataRoot, store, pi });
  const stopPreparing = installChatPreparation(service);
  const attention = new CoreAttention(dataRoot, service);
  const threadCoordination = new ThreadCoordinationService(service, store);
  const routines = new RoutineScheduler(store, service, browserControl);
  routines.onAlert = (chatId, title, message) => attention.alert(chatId, title, message);
  const capabilityTools = new CapabilityToolService(registry, mcpMigration, pi, store, routines);
  pi.setThreadToolHost(threadCoordination);
  pi.setCapabilityToolHost(capabilityTools);
  service.management.setActionRunner((chatId, action, input) =>
    capabilityTools.executeManagementAction(chatId, action, input),
  );
  service.management.setReader((selectedChatId) =>
    readManagementSnapshot(service, store, capabilityTools, selectedChatId),
  );
  service.management.setHomeReader(() => readHomeManagementSnapshot(service, store));
  const ready = initializeRuntime(registry, mcpMigration, threadCoordination, routines, service);

  return {
    service,
    attention,
    threadCoordination,
    browserControl,
    ready,
    close: async () => {
      stopPreparing();
      await attention.close();
      routines.close();
      threadCoordination.close();
      await pi.closeAll();
      siteScripts.close();
      closeRuntimeStores(service, store);
    },
  };
}

async function readManagementSnapshot(
  service: ChatService,
  store: ReturnType<typeof openChatStore>,
  capabilityTools: CapabilityToolService,
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
    capabilityRevision: catalog.revision,
    capabilities,
    resources,
    resourceError,
  };
}

async function readHomeManagementSnapshot(
  service: ChatService,
  store: ReturnType<typeof openChatStore>,
): Promise<unknown> {
  return {
    routines: store
      .listRoutines()
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
  service: ChatService,
): Promise<void> {
  await registry.initialize();
  await migration.migrate(await registry.snapshot());
  await threads.recover();
  await routines.start();
  // Warm the next chat's resources in the background: readiness must not wait on compiling
  // extensions (seconds when cold), and the first chat joins this same preparation.
  void prepareChat(service);
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
      ...(routine.check ? { checks: true } : {}),
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
        "openai-codex",
      id: readEnvironment("INITIAL_MODEL_ID") || "gpt-6-luna",
    },
    browserTool: browserControl.execute.bind(browserControl),
  });
  return pi;
}

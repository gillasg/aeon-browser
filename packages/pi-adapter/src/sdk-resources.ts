import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  loadMcpConfig,
  type AgentSession,
  type ExtensionUIContext,
  type InlineExtension,
  type McpServerStatus,
  type McpExtensionOptions,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

export function createPiResourceLoader(input: {
  workingDirectory: string;
  agentDirectory: string;
  settingsManager: SettingsManager;
  mcpOptions?: McpExtensionOptions;
  onMcpStatusChange?: (servers: readonly McpServerStatus[]) => void;
  additionalFactories?: readonly InlineExtension[];
}): ResourceLoader {
  const onMcpStatusChange = input.onMcpStatusChange;
  const existingStatusListener = input.mcpOptions?.onStatusChange;
  const loadConfig =
    input.mcpOptions?.loadConfig ??
    ((context) =>
      loadMcpConfig({
        agentDir: input.agentDirectory,
        cwd: context.cwd,
        projectTrusted: context.isProjectTrusted(),
      }));
  return new DefaultResourceLoader({
    cwd: input.workingDirectory,
    agentDir: input.agentDirectory,
    settingsManager: input.settingsManager,
    extensionFactories: [
      createCodemodeExtension(),
      createToolSearchExtension(),
      createMcpExtension({
        ...input.mcpOptions,
        loadConfig,
        ...(onMcpStatusChange || existingStatusListener
          ? {
              onStatusChange: (servers) => {
                existingStatusListener?.(servers);
                onMcpStatusChange?.(servers);
              },
            }
          : {}),
      }),
      ...(input.additionalFactories ?? []),
    ],
  });
}

export async function bindPiExtensions(
  session: AgentSession,
  uiContext: ExtensionUIContext,
): Promise<void> {
  await session.bindExtensions({
    uiContext,
    mode: "rpc",
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async (targetId, options) => {
        const result = await session.navigateTree(targetId, options);
        return { cancelled: result.cancelled };
      },
      switchSession: async () => ({ cancelled: true }),
      reload: () => reloadPiResources(session),
    },
    onError: ({ extensionPath }) => {
      uiContext.notify(`Pi extension command failed (${extensionPath.slice(0, 160)}).`, "warning");
    },
  });
  // Pi resolves defaultTools before SDK extension tools register. Re-apply the configured names
  // after binding so +codemode and +tool_search actually become active in SDK sessions.
  enablePiNativeDefaultTools(session.settingsManager);
  applyConfiguredExtensionTools(session);
}

export async function reloadPiResources(session: AgentSession): Promise<void> {
  const previouslyActiveTools = session.getActiveToolNames();
  await session.reload({
    beforeSessionStart: () => {
      enablePiNativeDefaultTools(session.settingsManager);
      applyConfiguredExtensionTools(session, previouslyActiveTools);
    },
  });
}

export function enablePiNativeDefaultTools(settingsManager: SettingsManager): void {
  const required = new Set(["codemode", "tool_search"]);
  const configured = (settingsManager.getDefaultTools() ?? []).filter(
    (name) => !required.has(name.replace(/^[+-]/, "")),
  );
  settingsManager.applyOverrides({ defaultTools: [...configured, "+codemode", "+tool_search"] });
}

function applyConfiguredExtensionTools(
  session: AgentSession,
  preserveNames: readonly string[] = [],
): void {
  const configuredTools = session.settingsManager.getDefaultTools();
  const active = new Set([...session.getActiveToolNames(), ...preserveNames]);
  for (const name of configuredTools ?? []) active.add(name);
  session.setActiveToolsByName([...active]);
}

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
import { browserRuntimePrimer } from "./browser-code-guidance.js";
import { browserProfileGuard } from "./browser-profile-guard.js";
import { idleWaitGuard } from "./idle-wait-guard.js";
import { browserAbilitySearch } from "./browser-ability-search.js";

/** Skills written for agents outside Aeon (they drive Aeon from a shell). */
const OUTSIDE_AGENT_SKILLS = new Set(["aeon"]);

export function withoutOutsideAgentSkills<T extends { name: string }>(skills: readonly T[]): T[] {
  return skills.filter((skill) => !OUTSIDE_AGENT_SKILLS.has(skill.name));
}

export function createPiResourceLoader(input: {
  workingDirectory: string;
  agentDirectory: string;
  settingsManager: SettingsManager;
  mcpOptions?: McpExtensionOptions;
  onMcpStatusChange?: (servers: readonly McpServerStatus[]) => void;
  additionalFactories?: readonly InlineExtension[];
  browserGuidance?: boolean;
  /** Load the user's own Pi extensions, packages, skills and prompts (Settings, off by default). */
  personal?: boolean;
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
  const extensionFactories = [
    createCodemodeExtension(),
    createToolSearchExtension(),
    createMcpExtension({
      // Browser and local tools can run while optional MCP servers connect in the background.
      startupWaitMs: 0,
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
    ...(input.browserGuidance ? [browserAbilitySearch()] : []),
    browserProfileGuard(),
    idleWaitGuard(),
    ...(input.additionalFactories ?? []),
  ];
  return new DefaultResourceLoader({
    cwd: input.workingDirectory,
    agentDir: input.agentDirectory,
    settingsManager: input.personal
      ? input.settingsManager
      : withoutPackages(input.settingsManager),
    ...(input.personal ? {} : personalOff(extensionFactories)),
    appendSystemPromptOverride: (base) =>
      input.browserGuidance ? [...base, browserRuntimePrimer] : base,
    // The `aeon` skill teaches other agents to reach Aeon from a shell; Aeon's own agent already
    // has the browser tools, and reading it only costs context and confuses which tool to use.
    skillsOverride: (base) => ({ ...base, skills: withoutOutsideAgentSkills(base.skills) }),
    extensionFactories,
  });
}

/** Only Aeon's own extensions: the built-in ones still load by name, the user's do not. */
function personalOff(factories: readonly InlineExtension[]) {
  const builtin = factories
    .filter((factory) => typeof factory !== "function" && factory.builtin === true)
    .map((factory) => `builtin:${(factory as { name: string }).name}`);
  return {
    noExtensions: true,
    additionalExtensionPaths: builtin,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  };
}

/** The user's Pi packages stay unresolved (resolving one can install it from npm). */
function withoutPackages(settings: SettingsManager): SettingsManager {
  const global = settings.getGlobalSettings.bind(settings);
  const project = settings.getProjectSettings.bind(settings);
  settings.getGlobalSettings = () => ({ ...global(), packages: [] });
  settings.getProjectSettings = () => ({ ...project(), packages: [] });
  return settings;
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

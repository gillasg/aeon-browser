import {
  AgentSession,
  AgentSessionRuntime,
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  VERSION,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  readStoredCredential,
} from "@earendil-works/pi-coding-agent";

export const EXPECTED_PI_SDK_VERSION = "1.4.0" as const;

function inspectMethods(target: object, names: readonly string[]): Record<string, boolean> {
  return Object.fromEntries(
    names.map((name) => [name, typeof Reflect.get(target, name) === "function"]),
  );
}

function inspectAccessors(target: object, names: readonly string[]): Record<string, boolean> {
  return Object.fromEntries(
    names.map((name) => [
      name,
      typeof Object.getOwnPropertyDescriptor(target, name)?.get === "function",
    ]),
  );
}

export function inspectPiSdkRuntimeSurface(): object {
  if (VERSION !== EXPECTED_PI_SDK_VERSION) {
    throw new Error(`Expected Pi SDK ${EXPECTED_PI_SDK_VERSION}, loaded ${VERSION}.`);
  }
  return {
    version: VERSION,
    factory: typeof createAgentSession === "function",
    sessionMethods: inspectMethods(AgentSession.prototype, [
      "prompt",
      "sendUserMessage",
      "abort",
      "followUp",
      "steer",
      "sendCustomMessage",
      "clearQueue",
      "navigateTree",
      "compact",
      "setModel",
      "setThinkingLevel",
      "bindExtensions",
      "reload",
    ]),
    sessionAccessors: inspectAccessors(AgentSession.prototype, [
      "isIdle",
      "isStreaming",
      "extensionRunner",
    ]),
    sessionManagerFactories: inspectMethods(SessionManager, ["create", "open", "findById"]),
    sessionManagerMethods: inspectMethods(SessionManager.prototype, [
      "getEntries",
      "getTree",
      "getSessionId",
      "getSessionFile",
    ]),
    sessionRuntimeMethods: inspectMethods(AgentSessionRuntime.prototype, ["fork"]),
    extensionRunnerMethods: inspectMethods(ExtensionRunner.prototype, [
      "getRegisteredCommands",
      "getCommand",
    ]),
    resourceLoaderMethods: inspectMethods(DefaultResourceLoader.prototype, [
      "getExtensions",
      "getSkills",
      "reload",
    ]),
    providerSetupExports: {
      modelRegistry: typeof ModelRegistry === "function",
      settingsManager: typeof SettingsManager === "function",
      credentialReader: typeof readStoredCredential === "function",
      codemodeExtensionFactory: typeof createCodemodeExtension === "function",
      mcpExtensionFactory: typeof createMcpExtension === "function",
      toolSearchExtensionFactory: typeof createToolSearchExtension === "function",
    },
  };
}

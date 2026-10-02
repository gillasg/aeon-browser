import { resolve } from "node:path";
import type { McpCapability } from "@pippin/domain";

export type PiMcpServerConfig =
  | {
      type: "stdio";
      command: string;
      args: string[];
      cwd: string;
      env?: Record<string, string>;
      enabled: boolean;
      exposure: "codemode";
    }
  | {
      type: "http";
      url: string;
      headers?: Record<string, string>;
      enabled: boolean;
      exposure: "codemode";
    };

export interface MappedPiMcpServer {
  name: string;
  config: PiMcpServerConfig;
  warning?: "manual-credential-binding-required";
}

export interface PiCliBridgeConfig {
  command: string;
  scriptPath: string;
  registryPath: string;
}

export function mapMcpCapabilityToPi(
  capability: McpCapability,
  defaultWorkingDirectory: string,
): MappedPiMcpServer {
  const name = piMcpServerName(capability.id);
  const { envCredential, manualCredential } = credentialBinding(capability.credentialReference);
  if (capability.transport === "stdio") {
    if (!capability.command) throw new Error("Legacy stdio MCP capability is missing its command.");
    return {
      name,
      config: {
        type: "stdio",
        command: capability.command,
        args: [...capability.args],
        cwd: resolve(defaultWorkingDirectory, capability.workingDirectory ?? "."),
        ...(envCredential ? { env: { [envCredential]: envReference(envCredential) } } : {}),
        enabled: !manualCredential,
        exposure: "codemode",
      },
      ...(manualCredential ? { warning: "manual-credential-binding-required" } : {}),
    };
  }
  if (!capability.endpoint) throw new Error("Legacy HTTP MCP capability is missing its endpoint.");
  return {
    name,
    config: {
      type: "http",
      url: capability.endpoint,
      ...(envCredential
        ? { headers: { Authorization: `Bearer ${envReference(envCredential)}` } }
        : {}),
      enabled: !manualCredential,
      exposure: "codemode",
    },
    ...(manualCredential ? { warning: "manual-credential-binding-required" } : {}),
  };
}

export function piMcpServerName(capabilityId: string): string {
  if (!/^cap_[a-z0-9][a-z0-9_-]{0,58}$/.test(capabilityId))
    throw new Error("Legacy MCP capability has an invalid ID.");
  return `pippin_${capabilityId.slice("cap_".length)}`;
}

export function mapRegisteredCliBridge(
  bridge: PiCliBridgeConfig,
  defaultWorkingDirectory: string,
): MappedPiMcpServer {
  return {
    name: "pippin_cli",
    config: {
      type: "stdio",
      command: bridge.command,
      args: [bridge.scriptPath, "--registry", bridge.registryPath],
      cwd: resolve(defaultWorkingDirectory),
      enabled: true,
      exposure: "codemode",
    },
  };
}

function envReference(name: string): string {
  return "$" + "{" + name + "}";
}

function credentialBinding(credential: string | null | undefined): {
  envCredential: string | null;
  manualCredential: boolean;
} {
  return {
    envCredential: credential?.startsWith("env:") ? credential.slice(4) : null,
    manualCredential:
      credential === "external-config-only" || (credential?.startsWith("external:") ?? false),
  };
}

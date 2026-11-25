import { posix, win32 } from "node:path";
import type { McpCapability } from "@aeon/domain";
import { parseCredentialBindings, type CredentialBinding } from "./mcp-credentials.js";

export type PiMcpServerConfig =
  | {
      type: "stdio";
      command: string;
      args: string[];
      cwd: string;
      env?: Record<string, string>;
      /** What the server is for: Pi shows it to the model and ranks the server's tools by it. */
      description?: string;
      enabled: boolean;
      exposure: "codemode";
    }
  | {
      type: "http";
      url: string;
      headers?: Record<string, string>;
      description?: string;
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
  const { bindings, manualCredential } = credentialBinding(capability.credentialReference);
  if (capability.transport === "stdio") {
    if (!capability.command) throw new Error("Legacy stdio MCP capability is missing its command.");
    return {
      name,
      config: {
        type: "stdio",
        command: capability.command,
        args: [...capability.args],
        cwd: resolveConfiguredDirectory(
          defaultWorkingDirectory,
          capability.workingDirectory ?? ".",
        ),
        ...(bindings.length
          ? {
              env: Object.fromEntries(
                bindings.map((binding) => [binding.env, envReference(binding.env)]),
              ),
            }
          : {}),
        ...describe(capability),
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
      ...(bindings.length ? { headers: piHeaders(bindings) } : {}),
      ...describe(capability),
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
      cwd: resolveConfiguredDirectory(defaultWorkingDirectory),
      description: "The command-line tools the user registered in Aeon.",
      enabled: true,
      exposure: "codemode",
    },
  };
}

/** The server names are opaque ids, so the description carries its name and purpose. */
function describe(capability: McpCapability): { description?: string } {
  const text = [capability.displayName, capability.description]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(": ")
    .slice(0, 300);
  return text ? { description: text } : {};
}

function envReference(name: string): string {
  return "$" + "{" + name + "}";
}

/** A Windows base stays a Windows path on macOS and Linux. Other bases use the host path style. */
function resolveConfiguredDirectory(base: string, child?: string): string {
  const paths =
    process.platform === "win32" || /^[A-Za-z]:[\\/]/.test(base) || base.startsWith("\\\\")
      ? win32
      : posix;
  return child === undefined ? paths.resolve(base) : paths.resolve(base, child);
}

function piHeaders(bindings: CredentialBinding[]): Record<string, string> {
  return Object.fromEntries(
    bindings.map((binding) =>
      binding.header
        ? [binding.header, envReference(binding.env)]
        : ["Authorization", `Bearer ${envReference(binding.env)}`],
    ),
  );
}

function credentialBinding(credential: string | null | undefined): {
  bindings: CredentialBinding[];
  manualCredential: boolean;
} {
  return {
    bindings: parseCredentialBindings(credential),
    manualCredential:
      credential === "external-config-only" || (credential?.startsWith("external:") ?? false),
  };
}

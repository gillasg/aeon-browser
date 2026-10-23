import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CapabilityRegistryFile, McpCapability } from "@aeon/domain";
import {
  mapMcpCapabilityToPi,
  mapRegisteredCliBridge,
  type MappedPiMcpServer,
  type PiCliBridgeConfig,
} from "./mcp-registry-mapping.js";
export const MANIFEST_SCHEMA_VERSION = 1;
export interface MigrationManifest {
  schemaVersion: 1;
  status: "prepared" | "complete";
  createdAt: string;
  completedAt: string | null;
  registryRevision: number;
  registryBackup: string | null;
  mcpConfigBackup: string | null;
  originalMcpConfigExisted: boolean;
  servers: Array<{
    capabilityId: string;
    serverName: string;
    configHash: string;
    owned?: boolean;
    warning?: "manual-credential-binding-required";
  }>;
  previousServers?: MigrationManifest["servers"];
}
export type ConfiguredPiServer = {
  capabilityId: string;
  mapped: MappedPiMcpServer;
};
const CLI_BRIDGE_CAPABILITY_ID = "pippin_cli_bridge";
export function mapRegistryServers(
  registry: CapabilityRegistryFile,
  defaultWorkingDirectory: string,
  cliBridge?: PiCliBridgeConfig,
): ConfiguredPiServer[] {
  const servers = registry.capabilities
    .filter((capability): capability is McpCapability => capability.kind === "mcp")
    .map((capability) => ({
      capabilityId: capability.id,
      mapped: mapMcpCapabilityToPi(capability, defaultWorkingDirectory),
    }));
  if (cliBridge && registry.capabilities.some((capability) => capability.kind === "cli"))
    servers.push({
      capabilityId: CLI_BRIDGE_CAPABILITY_ID,
      mapped: mapRegisteredCliBridge(cliBridge, defaultWorkingDirectory),
    });
  return servers;
}
export async function readManifest(path: string): Promise<MigrationManifest | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Pi MCP migration manifest is invalid JSON; the file was preserved.");
  }
  if (!isRecord(candidate) || candidate.schemaVersion !== MANIFEST_SCHEMA_VERSION)
    throw new Error("Pi MCP migration manifest has an unsupported schema; the file was preserved.");
  if (!validManifestFields(candidate))
    throw new Error("Pi MCP migration manifest is invalid; the file was preserved.");
  return candidate as unknown as MigrationManifest;
}
export async function readPiMcpConfig(path: string): Promise<{
  existed: boolean;
  value: Record<string, unknown>;
}> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return { existed: false, value: { mcpServers: {} } };
    throw error;
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Pi mcp.json is invalid JSON; the original file was preserved.");
  }
  if (
    !isRecord(candidate) ||
    (candidate.mcpServers !== undefined && !isRecord(candidate.mcpServers))
  )
    throw new Error(
      "Pi mcp.json has an invalid mcpServers field; the original file was preserved.",
    );
  return {
    existed: true,
    value: { ...candidate, mcpServers: { ...(candidate.mcpServers ?? {}) } },
  };
}
export function reconcileMappedServers(
  config: Record<string, unknown>,
  mapped: readonly ConfiguredPiServer[],
  previous: readonly MigrationManifest["servers"][number][],
): {
  config: Record<string, unknown>;
  configChanged: boolean;
  manifestServers: MigrationManifest["servers"];
} {
  const currentServers = isRecord(config.mcpServers) ? config.mcpServers : {};
  const nextServers: Record<string, unknown> = { ...currentServers };
  const previousByCapability = new Map(previous.map((item) => [item.capabilityId, item]));
  const presentCapabilityIds = new Set(mapped.map(({ capabilityId }) => capabilityId));
  const manifestServers: MigrationManifest["servers"] = [];
  let configChanged = false;
  for (const { capabilityId, mapped: server } of mapped) {
    const prior = previousByCapability.get(capabilityId);
    const current = currentServers[server.name];
    const reconciliation = reconcileServer(server, prior, current, nextServers);
    const owned = reconciliation.owned;
    configChanged ||= reconciliation.changed;
    manifestServers.push({
      capabilityId,
      serverName: server.name,
      configHash: managedConfigHash(server.config),
      owned,
      ...(server.warning ? { warning: server.warning } : {}),
    });
  }
  for (const prior of previous) {
    if (presentCapabilityIds.has(prior.capabilityId)) continue;
    const current = nextServers[prior.serverName];
    if (
      prior.owned !== false &&
      current !== undefined &&
      managedConfigHash(current) === prior.configHash
    ) {
      delete nextServers[prior.serverName];
      configChanged = true;
    }
  }
  return {
    config: { ...config, mcpServers: nextServers },
    configChanged,
    manifestServers,
  };
}

export function preparedTargetIsApplied(
  config: Record<string, unknown>,
  mapped: readonly ConfiguredPiServer[],
  manifest: MigrationManifest,
): boolean {
  const configured = isRecord(config.mcpServers) ? config.mcpServers : {};
  if (manifest.servers.length !== mapped.length) return false;
  const recordedById = new Map(manifest.servers.map((item) => [item.capabilityId, item]));
  for (const { capabilityId, mapped: server } of mapped) {
    const record = recordedById.get(capabilityId);
    if (!preparedServerMatches(record, server, configured[server.name])) return false;
  }
  const presentIds = new Set(mapped.map(({ capabilityId }) => capabilityId));
  for (const previous of manifest.previousServers ?? []) {
    if (presentIds.has(previous.capabilityId) || previous.owned === false) continue;
    const current = configured[previous.serverName];
    if (current !== undefined && managedConfigHash(current) === previous.configHash) return false;
  }
  return true;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isManifestServer(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.capabilityId === "string" &&
    typeof value.serverName === "string" &&
    typeof value.configHash === "string" &&
    /^[a-f0-9]{64}$/.test(value.configHash) &&
    (value.owned === undefined || typeof value.owned === "boolean") &&
    (value.warning === undefined || value.warning === "manual-credential-binding-required")
  );
}

function managedConfigHash(value: unknown): string {
  if (!isRecord(value)) return hashJson(value);
  const managed = { ...value };
  delete managed.enabled;
  delete managed.exposure;
  return hashJson(managed);
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}
function validManifestFields(candidate: Record<string, unknown>): boolean {
  const strings = [candidate.completedAt, candidate.registryBackup, candidate.mcpConfigBackup];
  return (
    ["prepared", "complete"].includes(String(candidate.status)) &&
    typeof candidate.createdAt === "string" &&
    strings.every(nullableString) &&
    Number.isSafeInteger(candidate.registryRevision) &&
    (candidate.registryRevision as number) >= 0 &&
    typeof candidate.originalMcpConfigExisted === "boolean" &&
    validServerArray(candidate.servers) &&
    (candidate.previousServers === undefined || validServerArray(candidate.previousServers))
  );
}
function validServerArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isManifestServer);
}

function reconcileServer(
  server: MappedPiMcpServer,
  prior: MigrationManifest["servers"][number] | undefined,
  current: unknown,
  nextServers: Record<string, unknown>,
): { owned: boolean; changed: boolean } {
  let configChanged = false;
  let owned = prior?.owned ?? false;
  if (current === undefined) {
    if (!prior) {
      nextServers[server.name] = server.config;
      configChanged = true;
      owned = true;
    } else owned = false;
  } else if (!prior) {
    if (managedConfigHash(current) !== managedConfigHash(server.config))
      throw new Error(
        `Pi MCP migration found a conflicting server named '${server.name}'; no config was changed.`,
      );
    owned = false;
  } else if (!isRecord(current)) {
    throw new Error(
      `Pi MCP migration found a conflicting server named '${server.name}'; no config was changed.`,
    );
  } else {
    const updated = reconcileExistingServer(server, prior, current, owned, nextServers);
    owned = updated.owned;
    configChanged = updated.changed;
  }
  return { owned, changed: configChanged };
}

function preparedServerMatches(
  record: MigrationManifest["servers"][number] | undefined,
  server: MappedPiMcpServer,
  current: unknown,
): boolean {
  if (
    !record ||
    record.serverName !== server.name ||
    record.configHash !== managedConfigHash(server.config)
  )
    return false;
  if (current === undefined) {
    if (record.owned !== false) return false;
  } else if (managedConfigHash(current) !== managedConfigHash(server.config)) return false;
  return true;
}

function reconcileExistingServer(
  server: MappedPiMcpServer,
  prior: MigrationManifest["servers"][number],
  current: Record<string, unknown>,
  owned: boolean,
  nextServers: Record<string, unknown>,
): { owned: boolean; changed: boolean } {
  let configChanged = false;

  const currentHash = managedConfigHash(current);
  const nextHash = managedConfigHash(server.config);
  if (prior.owned !== false && currentHash !== prior.configHash) {
    if (prior.configHash !== nextHash)
      throw new Error(
        `Pi MCP server '${server.name}' was edited in Pi; reconcile that change before updating its Aeon registration.`,
      );
    owned = false;
  } else if (prior.owned === false && currentHash !== nextHash) {
    throw new Error(
      `Pi MCP migration found a conflicting server named '${server.name}'; no config was changed.`,
    );
  } else if (owned && prior.configHash !== nextHash) {
    const updated = {
      ...current,
      ...server.config,
      ...(Object.hasOwn(current, "enabled") ? { enabled: current.enabled } : {}),
      ...(Object.hasOwn(current, "exposure") ? { exposure: current.exposure } : {}),
    };
    if (hashJson(updated) !== hashJson(current)) {
      nextServers[server.name] = updated;
      configChanged = true;
    }
  }

  return { owned, changed: configChanged };
}

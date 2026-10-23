import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CapabilityRegistryFile } from "@aeon/domain";
import type { PiCliBridgeConfig } from "./mcp-registry-mapping.js";
import {
  MANIFEST_SCHEMA_VERSION,
  type MigrationManifest,
  mapRegistryServers,
  preparedTargetIsApplied,
  readManifest,
  readPiMcpConfig,
  reconcileMappedServers,
  stableJson,
} from "./pi-mcp-config-state.js";
import { atomicWriteJson, copyOnce, existingMode } from "./pi-mcp-config-storage.js";

export interface PiMcpConfigMigrationResult {
  status: "migrated" | "already-migrated";
  registryRevision: number;
  serverCount: number;
  manualCredentialBindingCount: number;
}

export class PiMcpConfigMigration {
  private readonly manifestPath: string;
  private readonly mcpConfigPath: string;
  private readonly registryBackupPath: string;
  private readonly mcpConfigBackupPath: string;

  constructor(
    private readonly input: {
      dataDirectory: string;
      legacyRegistryPath: string;
      piAgentDirectory: string;
      defaultWorkingDirectory: string;
      cliBridge?: PiCliBridgeConfig;
    },
  ) {
    const migrationDirectory = join(input.dataDirectory, "pi-migration");
    this.manifestPath = join(migrationDirectory, "mcp-manifest.json");
    this.registryBackupPath = join(migrationDirectory, "capabilities.original.json");
    this.mcpConfigBackupPath = join(migrationDirectory, "mcp.original.json");
    this.mcpConfigPath = join(input.piAgentDirectory, "mcp.json");
  }

  async validate(registry: CapabilityRegistryFile): Promise<void> {
    const existingManifest = await readManifest(this.manifestPath);
    const mapped = mapRegistryServers(
      registry,
      this.input.defaultWorkingDirectory,
      this.input.cliBridge,
    );
    const currentConfig = await readPiMcpConfig(this.mcpConfigPath);
    reconcileMappedServers(currentConfig.value, mapped, existingManifest?.servers ?? []);
  }

  async migrate(registry: CapabilityRegistryFile): Promise<PiMcpConfigMigrationResult> {
    const existingManifest = await readManifest(this.manifestPath);
    const mapped = mapRegistryServers(
      registry,
      this.input.defaultWorkingDirectory,
      this.input.cliBridge,
    );
    const currentConfig = await readPiMcpConfig(this.mcpConfigPath);
    const previousServers = priorServers(existingManifest);
    if (
      existingManifest?.status === "prepared" &&
      existingManifest.registryRevision === registry.revision &&
      preparedTargetIsApplied(currentConfig.value, mapped, existingManifest)
    ) {
      const completed = completeManifest(existingManifest);
      await atomicWriteJson(this.manifestPath, completed);
      return summarize(completed, "migrated");
    }
    const reconciled = reconcileMappedServers(currentConfig.value, mapped, previousServers);
    const snapshots = await this.snapshotReferences(existingManifest, currentConfig.existed);
    const manifest = prepareManifest(
      existingManifest,
      registry.revision,
      snapshots,
      reconciled.manifestServers,
      previousServers,
    );
    if (
      existingManifest?.status === "complete" &&
      existingManifest.registryRevision === manifest.registryRevision &&
      !reconciled.configChanged &&
      stableJson(existingManifest.servers) === stableJson(manifest.servers)
    )
      return summarize(existingManifest, "already-migrated");
    await atomicWriteJson(this.manifestPath, manifest);
    if (reconciled.configChanged)
      await atomicWriteJson(
        this.mcpConfigPath,
        reconciled.config,
        await existingMode(this.mcpConfigPath),
      );
    const completed = completeManifest(manifest);
    await atomicWriteJson(this.manifestPath, completed);
    return summarize(completed, "migrated");
  }

  private async snapshotReferences(
    existingManifest: MigrationManifest | undefined,
    existed: boolean,
  ): Promise<
    Pick<MigrationManifest, "registryBackup" | "mcpConfigBackup" | "originalMcpConfigExisted">
  > {
    const snapshots = existingManifest
      ? {
          registryBackup: existingManifest.registryBackup,
          mcpConfigBackup: existingManifest.mcpConfigBackup,
          originalMcpConfigExisted: existingManifest.originalMcpConfigExisted,
        }
      : {
          ...(await this.createSnapshots(existed)),
          originalMcpConfigExisted: existed,
        };
    return snapshots;
  }

  private async createSnapshots(mcpConfigExisted: boolean): Promise<{
    registryBackup: string | null;
    mcpConfigBackup: string | null;
  }> {
    await mkdir(dirname(this.manifestPath), { recursive: true, mode: 0o700 });
    const registryBackup = await copyOnce(this.input.legacyRegistryPath, this.registryBackupPath);
    const mcpConfigBackup = mcpConfigExisted
      ? await copyOnce(this.mcpConfigPath, this.mcpConfigBackupPath)
      : null;
    return { registryBackup, mcpConfigBackup };
  }
}

function completeManifest(manifest: MigrationManifest): MigrationManifest {
  const completed = {
    ...manifest,
    status: "complete" as const,
    completedAt: new Date().toISOString(),
  };
  delete completed.previousServers;
  return completed;
}

function summarize(
  manifest: MigrationManifest,
  status: PiMcpConfigMigrationResult["status"],
): PiMcpConfigMigrationResult {
  return {
    status,
    registryRevision: manifest.registryRevision,
    serverCount: manifest.servers.length,
    manualCredentialBindingCount: manifest.servers.filter(
      ({ warning }) => warning === "manual-credential-binding-required",
    ).length,
  };
}

function prepareManifest(
  existingManifest: MigrationManifest | undefined,
  revision: number,
  snapshots: Pick<
    MigrationManifest,
    "registryBackup" | "mcpConfigBackup" | "originalMcpConfigExisted"
  >,
  servers: MigrationManifest["servers"],
  previousServers: MigrationManifest["servers"],
): MigrationManifest {
  const manifest: MigrationManifest = {
    ...(existingManifest ?? {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      status: "prepared" as const,
      createdAt: new Date().toISOString(),
      completedAt: null,
      registryRevision: revision,
      registryBackup: snapshots.registryBackup,
      mcpConfigBackup: snapshots.mcpConfigBackup,
      originalMcpConfigExisted: snapshots.originalMcpConfigExisted,
      servers: [],
    }),
    status: "prepared",
    completedAt: null,
    registryRevision: revision,
    registryBackup: snapshots.registryBackup,
    mcpConfigBackup: snapshots.mcpConfigBackup,
    originalMcpConfigExisted: snapshots.originalMcpConfigExisted,
    servers: servers,
    previousServers,
  };
  return manifest;
}

function priorServers(manifest: MigrationManifest | undefined): MigrationManifest["servers"] {
  return manifest?.status === "prepared"
    ? (manifest.previousServers ?? [])
    : (manifest?.servers ?? []);
}

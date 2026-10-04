import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  CapabilityAuditRecord,
  CapabilityDefinition,
  CapabilityRegistryFile,
  CapabilityVerification,
  ChatId,
  PippinProductStore,
} from "@pippin/domain";
import { atomicWrite, withRegistryLock } from "./capability-registry-file.js";
import {
  isRecord,
  MAX_CAPABILITIES,
  needsCheck,
  parseCapability,
  parseRegistry,
  REGISTRY_SCHEMA_VERSION,
} from "./capability-parsing.js";

export class CapabilityRegistry {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly filePath: string,
    private readonly store: PippinProductStore,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const registry = await this.readOrCreate();
    const latestAudit = this.store.listCapabilityAudit(1)[0];
    if (registry.revision > 0 && (latestAudit?.revision ?? 0) < registry.revision) {
      this.store.appendCapabilityAudit({
        revision: registry.revision,
        capabilityId: "registry",
        action: "reconcile",
        actorChatId: null,
        createdAt: new Date().toISOString(),
        result: "Recovered canonical registry revision from capabilities.json.",
      });
    }
  }

  async snapshot(): Promise<CapabilityRegistryFile> {
    return this.readOrCreate();
  }

  register(
    expectedRevision: number,
    input: unknown,
    actorChatId: ChatId,
  ): Promise<CapabilityRegistryFile> {
    const definition = parseCapability(input);
    return this.mutate(expectedRevision, actorChatId, "register", definition.id, (current) => {
      if (current.capabilities.some((capability) => capability.id === definition.id))
        throw new Error(`Capability '${definition.id}' is already registered.`);
      if (current.capabilities.length >= MAX_CAPABILITIES)
        throw new Error(`The registry is limited to ${MAX_CAPABILITIES} capabilities.`);
      return { ...definition, verification: needsCheck() };
    });
  }

  update(
    expectedRevision: number,
    input: unknown,
    actorChatId: ChatId,
  ): Promise<CapabilityRegistryFile> {
    const definition = parseCapability(input);
    return this.mutate(expectedRevision, actorChatId, "update", definition.id, (current) => {
      if (!current.capabilities.some((capability) => capability.id === definition.id))
        throw new Error(`Capability '${definition.id}' is not registered.`);
      return { ...definition, verification: needsCheck() };
    });
  }

  remove(
    expectedRevision: number,
    capabilityId: string,
    actorChatId: ChatId,
  ): Promise<CapabilityRegistryFile> {
    return this.mutate(expectedRevision, actorChatId, "remove", capabilityId, (current) => {
      if (!current.capabilities.some((capability) => capability.id === capabilityId))
        throw new Error(`Capability '${capabilityId}' is not registered.`);
      return null;
    });
  }

  updateVerification(
    expectedRevision: number,
    capabilityId: string,
    verification: CapabilityVerification,
    actorChatId: ChatId,
  ): Promise<CapabilityRegistryFile> {
    return this.mutate(expectedRevision, actorChatId, "recheck", capabilityId, (current) => {
      const prior = current.capabilities.find((capability) => capability.id === capabilityId);
      if (!prior) throw new Error(`Capability '${capabilityId}' is not registered.`);
      return { ...prior, verification };
    });
  }

  private async mutate(
    expectedRevision: number,
    actorChatId: ChatId,
    action: CapabilityAuditRecord["action"],
    capabilityId: string,
    transform: (current: CapabilityRegistryFile) => CapabilityDefinition | null,
  ): Promise<CapabilityRegistryFile> {
    return withRegistryLock(this.locks, async () => {
      const current = await this.readOrCreate();
      if (current.revision !== expectedRevision)
        throw new Error(`CAPABILITY_REVISION_CONFLICT: current revision is ${current.revision}.`);
      const changed = transform(current);
      const capabilities = current.capabilities.filter((item) => item.id !== capabilityId);
      if (changed) capabilities.push(changed);
      const next: CapabilityRegistryFile = {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        revision: current.revision + 1,
        capabilities: capabilities.sort((left, right) => left.id.localeCompare(right.id)),
      };
      await atomicWrite(this.filePath, next);
      this.store.appendCapabilityAudit({
        revision: next.revision,
        capabilityId,
        action,
        actorChatId,
        createdAt: new Date().toISOString(),
        result: `${action} committed at registry revision ${next.revision}.`,
      });
      return next;
    });
  }

  private async readOrCreate(): Promise<CapabilityRegistryFile> {
    try {
      return parseRegistry(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const empty: CapabilityRegistryFile = {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        revision: 0,
        capabilities: [],
      };
      await atomicWrite(this.filePath, empty);
      return empty;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

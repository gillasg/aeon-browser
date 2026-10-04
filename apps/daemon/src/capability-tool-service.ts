import { randomUUID } from "node:crypto";
import type {
  CapabilityDefinition,
  CapabilityRegistryFile,
  ChatId,
  McpCapability,
  PiMcpServerStatus,
  PippinProductStore,
} from "@pippin/domain";
import type { CapabilityToolHost } from "@pippin/pi-adapter";
import type { CapabilityRegistry } from "./capability-registry.js";
import { verifyCliCapability } from "./capability-verification.js";
import { parseCapability } from "./capability-parsing.js";
import { PiMcpConfigMigration } from "./pi-mcp-config-migration.js";
import { piMcpServerName } from "./mcp-registry-mapping.js";
import type { RoutineScheduler } from "./routine-scheduler.js";
import type { ManagementActionName } from "./management-actions.js";
import { isRoutineTool, RoutineManagementTools } from "./routine-management-tools.js";

export interface PiMcpSessionHost {
  reloadAllResources(): Promise<void>;
  reloadChatResources(chatId: string): Promise<{
    statuses: readonly PiMcpServerStatus[];
    deferred: boolean;
  }>;
}

export class CapabilityToolService implements CapabilityToolHost {
  private readonly routineTools: RoutineManagementTools;

  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly mcpMigration: PiMcpConfigMigration,
    private readonly piMcp: PiMcpSessionHost,
    private readonly store: PippinProductStore,
    private readonly routines: RoutineScheduler,
  ) {
    this.routineTools = new RoutineManagementTools(store, routines);
  }

  async executeManagementAction(
    chatId: string,
    action: ManagementActionName,
    input: Record<string, unknown>,
  ): Promise<void> {
    await this.execute(chatId, randomUUID(), action, input);
  }

  async readManagementCatalog(): Promise<unknown> {
    const snapshot = await this.registry.snapshot();
    return {
      revision: snapshot.revision,
      capabilities: snapshot.capabilities.map((item) => ({
        id: item.id,
        kind: item.kind,
        displayName: item.displayName,
        description: item.description,
        configReference: item.configReference,
        relatedSkillIds: item.relatedSkillIds,
        credentialConfigured: Boolean(item.credentialReference),
        credentialBinding: credentialBinding(item),
        verification: item.verification,
        ...(item.kind === "mcp" ? { connectionState: "not_reported" } : {}),
        loadedInSelectedChat: null,
      })),
    };
  }

  async execute(
    chatId: string,
    _toolCallId: string,
    toolName: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    const actor = chatId as ChatId;
    const args = asRecord(input);
    const result = isRoutineTool(toolName)
      ? this.routineTools.execute(toolName, args, actor)
      : await this.executeCapabilityTool(toolName, args, actor, signal);
    return JSON.stringify(result) ?? "null";
  }

  private async executeCapabilityTool(
    toolName: string,
    args: Record<string, unknown>,
    actor: ChatId,
    signal?: AbortSignal,
  ): Promise<unknown> {
    switch (toolName) {
      case "list_configured_capabilities":
        return await this.publicCatalog();
      case "register_capability":
        return await this.register(args, actor);
      case "update_capability":
        return await this.update(args, actor);
      case "remove_capability":
        return await this.remove(args, actor);
      case "recheck_capability":
        return await this.recheck(args, actor, signal);
      default:
        throw new Error(`Unknown daemon capability tool '${toolName}'.`);
    }
  }

  private async publicCatalog(): Promise<unknown> {
    const snapshot = await this.registry.snapshot();
    return {
      revision: snapshot.revision,
      capabilities: snapshot.capabilities.map((item) => ({
        id: item.id,
        kind: item.kind,
        displayName: item.displayName,
        description: item.description,
        configReference: item.configReference,
        relatedSkillIds: item.relatedSkillIds,
        credentialConfigured: Boolean(item.credentialReference),
        credentialBinding: credentialBinding(item),
        verification: item.verification,
        ...(item.kind === "cli"
          ? { launcher: item.launcher }
          : {
              transport: item.transport,
              command: item.command,
              args: item.args,
              endpoint: item.endpoint,
              workingDirectory: item.workingDirectory,
            }),
      })),
    };
  }

  private async register(args: Record<string, unknown>, actor: ChatId): Promise<unknown> {
    const before = await this.registry.snapshot();
    const candidate = parseCapability(args.capability);
    const preview = {
      ...before,
      revision: before.revision + 1,
      capabilities: [...before.capabilities, candidate],
    };
    await this.validateMcpChanges(before, preview);
    await this.registry.register(integer(args.expectedRevision), candidate, actor);
    await this.syncMcpChanges(before);
    return await this.publicCatalog();
  }

  private async update(args: Record<string, unknown>, actor: ChatId): Promise<unknown> {
    const candidate = asRecord(args.capability);
    const id = requiredString(candidate.id, "capability.id");
    const before = await this.registry.snapshot();
    const parsed = parseCapability(candidate);
    const preview = {
      ...before,
      revision: before.revision + 1,
      capabilities: before.capabilities.map((item) => (item.id === id ? parsed : item)),
    };
    await this.validateMcpChanges(before, preview);
    await this.registry.update(integer(args.expectedRevision), parsed, actor);
    await this.syncMcpChanges(before);
    return await this.publicCatalog();
  }

  private async remove(args: Record<string, unknown>, actor: ChatId): Promise<unknown> {
    const id = requiredString(args.capabilityId, "capabilityId");
    const before = await this.registry.snapshot();
    const preview = {
      ...before,
      revision: before.revision + 1,
      capabilities: before.capabilities.filter((item) => item.id !== id),
    };
    await this.validateMcpChanges(before, preview);
    await this.registry.remove(integer(args.expectedRevision), id, actor);
    await this.syncMcpChanges(before);
    return await this.publicCatalog();
  }

  private async recheck(
    args: Record<string, unknown>,
    actor: ChatId,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = requiredString(args.capabilityId, "capabilityId");
    const snapshot = await this.registry.snapshot();
    const capability = snapshot.capabilities.find((item) => item.id === id);
    if (!capability) throw new Error(`Capability '${id}' is not registered.`);
    const result =
      capability.kind === "mcp"
        ? await this.verifyPiMcp(capability, actor)
        : await verifyCliCapability(capability, signal);
    await this.registry.updateVerification(
      integer(args.expectedRevision),
      id,
      { ...result, checkedAt: new Date().toISOString() },
      actor,
    );
    return await this.publicCatalog();
  }

  private async verifyPiMcp(
    capability: McpCapability,
    chatId: ChatId,
  ): Promise<{ state: "needs_check" | "verified" | "failed"; summary: string }> {
    const refreshed = await this.piMcp.reloadChatResources(chatId);
    if (refreshed.deferred)
      return {
        state: "needs_check",
        summary: "Pi will reload this MCP server after the active run or dialog finishes.",
      };
    const status = refreshed.statuses.find(
      (candidate) => candidate.name === piMcpServerName(capability.id),
    );
    if (!status)
      return { state: "failed", summary: "Pi did not load this MCP server in the selected Chat." };
    if (status.state === "connected")
      return {
        state: "verified",
        summary: `Pi connected to the MCP server and loaded ${status.toolCount} tools and ${status.resourceCount} resources in this Chat.`,
      };
    const message =
      status.state === "needs-auth"
        ? "Pi reports that this MCP server needs sign-in. Use Pi's /mcp login command."
        : status.state === "disabled"
          ? "This MCP server is disabled in Pi's configuration."
          : status.state === "failed" || status.state === "disconnected"
            ? "Pi could not connect to this MCP server."
            : "Pi is still loading this MCP server.";
    return { state: "failed", summary: message };
  }

  private async syncMcpChanges(before: CapabilityRegistryFile): Promise<void> {
    const after = await this.registry.snapshot();
    if (mcpConfigSignature(before) === mcpConfigSignature(after)) return;
    await this.mcpMigration.migrate(after);
    await this.piMcp.reloadAllResources();
  }

  private async validateMcpChanges(
    before: CapabilityRegistryFile,
    preview: CapabilityRegistryFile,
  ): Promise<void> {
    if (mcpConfigSignature(before) === mcpConfigSignature(preview)) return;
    await this.mcpMigration.validate(preview);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Tool arguments must be an object.");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function integer(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0)
    throw new Error("expectedRevision is invalid.");
  return value as number;
}

function mcpConfigSignature(registry: CapabilityRegistryFile): string {
  return JSON.stringify({
    cliBridgeEnabled: registry.capabilities.some((capability) => capability.kind === "cli"),
    mcpServers: registry.capabilities
      .filter((capability) => capability.kind === "mcp")
      .map(({ id, transport, command, args, endpoint, workingDirectory, credentialReference }) => ({
        id,
        transport,
        command,
        args,
        endpoint,
        workingDirectory,
        credentialReference,
      })),
  });
}

function credentialBinding(
  capability: CapabilityDefinition,
):
  | "not_configured"
  | "environment_reference"
  | "external_configuration"
  | "manual_pi_binding_required" {
  const reference = capability.credentialReference;
  if (!reference) return "not_configured";
  if (reference.startsWith("env:")) return "environment_reference";
  return capability.kind === "mcp" ? "manual_pi_binding_required" : "external_configuration";
}

import { Client, type CallToolResult, type Tool } from "@modelcontextprotocol/client";
import type { CapabilityDefinition, McpCapability } from "@aeon/domain";
import type { CapabilityRegistry } from "./capability-registry.js";
import { McpTransportAdapter, type McpTransport } from "./mcp-transport-adapter.js";
import {
  boundValue,
  boundedString,
  boundedTools,
  capabilitySignature,
  hash,
  requestSignal,
  validateArguments,
} from "./mcp-client-utilities.js";

const CONNECTION_TIMEOUT_MS = 10_000;
const MCP_SDK_VERSION = "2.2.0";
const MAX_OPEN_CLIENTS = 4;
const IDLE_CLIENT_MS = 5 * 60_000;

interface ManagedClient {
  signature: string;
  client: Client;
  transport: McpTransport;
  lastUsedAt: number;
  connectedAt: string;
  serverVersion: unknown;
  protocolVersion: string | undefined;
  serverCapabilities: unknown;
}

interface DiscoveredTools {
  signature: string;
  schemaHash: string;
  tools: Tool[];
}

export class McpClientManager {
  private readonly clients = new Map<string, ManagedClient>();
  private readonly discovered = new Map<string, DiscoveredTools>();
  private readonly transportAdapter = new McpTransportAdapter();

  constructor(private readonly registry: CapabilityRegistry) {}

  async listMcpTools(serverId?: string, signal?: AbortSignal): Promise<unknown> {
    const snapshot = await this.registry.snapshot();
    const candidates = snapshot.capabilities.filter(
      (item): item is McpCapability => item.kind === "mcp" && (!serverId || item.id === serverId),
    );
    if (serverId && !candidates.length)
      throw new Error(`MCP capability '${serverId}' is not registered.`);
    const servers = [];
    for (const capability of candidates) {
      try {
        const managed = await this.ensureClient(capability, signal);
        const result = await managed.client.listTools(undefined, {
          cacheMode: "refresh",
          signal: requestSignal(signal),
        });
        const tools = boundedTools(result.tools);
        const schemaHash = hash(tools);
        this.discovered.set(capability.id, { signature: managed.signature, schemaHash, tools });
        servers.push({
          serverId: capability.id,
          displayName: capability.displayName,
          connection: "connected",
          sdkVersion: MCP_SDK_VERSION,
          serverVersion: managed.serverVersion,
          protocolVersion: managed.protocolVersion,
          serverCapabilities: boundValue(managed.serverCapabilities),
          connectedAt: managed.connectedAt,
          advertisedToolCount: result.tools.length,
          returnedToolCount: tools.length,
          toolsTruncated: tools.length < result.tools.length,
          tools: tools.map((tool) => ({
            serverId: capability.id,
            name: tool.name,
            description: boundedString(tool.description ?? "", 1000),
            inputSchema: boundValue(tool.inputSchema),
          })),
        });
      } catch {
        await this.invalidate(capability.id);
        if (signal?.aborted) throw new Error("MCP_REQUEST_CANCELLED: discovery was cancelled.");
        servers.push({
          serverId: capability.id,
          displayName: capability.displayName,
          connection: "unreachable",
          error: "MCP_CONNECTION_FAILED",
          tools: [],
        });
      }
    }
    return { registryRevision: snapshot.revision, servers };
  }

  async callMcpTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const capability = await this.requireMcpCapability(serverId);
    const { managed, tool } = await this.resolveAdvertisedTool(
      capability,
      serverId,
      toolName,
      signal,
    );
    const validatedArguments = await validateArguments(tool.inputSchema, args);
    const result = await this.invokeMcpTool(
      serverId,
      toolName,
      managed,
      tool,
      validatedArguments,
      signal,
    );
    return boundValue({
      serverId,
      toolName,
      isError: result.isError === true,
      content: result.content,
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent }),
    });
  }

  async verify(capability: McpCapability, signal?: AbortSignal): Promise<string> {
    await this.invalidate(capability.id);
    const managed = await this.ensureClient(capability, signal);
    let result: Awaited<ReturnType<Client["listTools"]>>;
    try {
      result = await managed.client.listTools(undefined, {
        cacheMode: "refresh",
        signal: requestSignal(signal),
      });
    } catch {
      await this.invalidate(capability.id);
      if (signal?.aborted) throw new Error("MCP_REQUEST_CANCELLED: verification was cancelled.");
      throw new Error(
        "MCP_CONNECTION_FAILED: the configured server did not complete tool discovery.",
      );
    }
    return `MCP handshake succeeded; SDK ${MCP_SDK_VERSION}; protocol ${managed.protocolVersion ?? "unknown"}; ${result.tools.length} tools.`;
  }

  status(): ReadonlyArray<{ capabilityId: string; state: "client_open" | "not_connected" }> {
    return [...this.clients.keys()].map((capabilityId) => ({ capabilityId, state: "client_open" }));
  }

  async invalidate(capabilityId: string): Promise<void> {
    this.discovered.delete(capabilityId);
    const managed = this.clients.get(capabilityId);
    this.clients.delete(capabilityId);
    if (managed) await closeManaged(managed);
  }

  async closeAll(): Promise<void> {
    const current = [...this.clients.values()];
    this.clients.clear();
    this.discovered.clear();
    await Promise.all(current.map(closeManaged));
  }

  private async ensureClient(
    capability: McpCapability,
    signal?: AbortSignal,
  ): Promise<ManagedClient> {
    if (signal?.aborted) throw new Error("MCP_REQUEST_CANCELLED: the request was cancelled.");
    await this.evictIdle();
    const signature = capabilitySignature(capability);
    const reusable = await this.reusableClient(capability.id, signature);
    if (reusable) return reusable;
    await this.makeClientRoom();
    return this.openClient(capability, signature, signal);
  }

  private async reusableClient(
    capabilityId: string,
    signature: string,
  ): Promise<ManagedClient | undefined> {
    const existing = this.clients.get(capabilityId);
    if (existing?.signature === signature) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (existing) await this.invalidate(capabilityId);
  }

  private async makeClientRoom(): Promise<void> {
    while (this.clients.size >= MAX_OPEN_CLIENTS) {
      const oldest = [...this.clients.entries()].sort(
        (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
      )[0];
      if (!oldest) break;
      await this.invalidate(oldest[0]);
    }
  }

  private async openClient(
    capability: McpCapability,
    signature: string,
    signal?: AbortSignal,
  ): Promise<ManagedClient> {
    const client = new Client({ name: "aeon-mcp-client", version: "1.0.0" });
    const transport = this.transportAdapter.create(capability);
    try {
      await client.connect(transport, { timeout: CONNECTION_TIMEOUT_MS });
    } catch {
      await client.close().catch(() => {});
      throw new Error(
        "MCP_CONNECTION_FAILED: the configured server did not complete its handshake.",
      );
    }
    if (signal?.aborted) {
      await client.close().catch(() => {});
      throw new Error("MCP_REQUEST_CANCELLED: connection setup was cancelled.");
    }
    const managed = {
      signature,
      client,
      transport,
      lastUsedAt: Date.now(),
      connectedAt: new Date().toISOString(),
      serverVersion: client.getServerVersion() ?? null,
      protocolVersion: client.getNegotiatedProtocolVersion(),
      serverCapabilities: client.getServerCapabilities() ?? {},
    };
    this.clients.set(capability.id, managed);
    return managed;
  }

  private async requireMcpCapability(serverId: string): Promise<McpCapability> {
    const capability = (await this.registry.snapshot()).capabilities.find(
      (item): item is McpCapability => item.kind === "mcp" && item.id === serverId,
    );
    if (!capability) throw new Error(`MCP capability '${serverId}' is not registered.`);
    return capability;
  }

  private async resolveAdvertisedTool(
    capability: McpCapability,
    serverId: string,
    toolName: string,
    signal?: AbortSignal,
  ): Promise<{ managed: ManagedClient; tool: Tool }> {
    const advertised = this.discovered.get(serverId);
    if (!advertised)
      throw new Error("MCP_DISCOVER_FIRST: list this server's tools before invoking one.");
    const managed = await this.ensureClient(capability, signal);
    let refreshed: Awaited<ReturnType<Client["listTools"]>>;
    try {
      refreshed = await managed.client.listTools(undefined, {
        cacheMode: "refresh",
        signal: requestSignal(signal),
      });
    } catch {
      await this.invalidate(serverId);
      if (signal?.aborted) throw new Error("MCP_REQUEST_CANCELLED: tool discovery was cancelled.");
      throw new Error("MCP_CONNECTION_FAILED: the configured server stopped responding.");
    }
    const tools = boundedTools(refreshed.tools);
    if (advertised.signature !== managed.signature || advertised.schemaHash !== hash(tools))
      throw new Error(
        "CAPABILITY_CHANGED: the server tool list or input schema changed; rediscover tools.",
      );
    const tool = tools.find((item) => item.name === toolName);
    if (!tool) throw new Error(`MCP tool '${serverId}:${toolName}' is not available.`);
    return { managed, tool };
  }

  private async invokeMcpTool(
    serverId: string,
    toolName: string,
    managed: ManagedClient,
    tool: Tool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    try {
      return await managed.client.callTool(
        { name: toolName, arguments: args },
        { signal: requestSignal(signal), toolDefinition: tool },
      );
    } catch {
      if (signal?.aborted) throw new Error("MCP_REQUEST_CANCELLED: the tool call was cancelled.");
      await this.invalidate(serverId);
      throw new Error("MCP_CALL_FAILED: the configured server did not complete the tool call.");
    }
  }

  private async evictIdle(): Promise<void> {
    const stale = [...this.clients.entries()].filter(
      ([, client]) => Date.now() - client.lastUsedAt > IDLE_CLIENT_MS,
    );
    for (const [id] of stale) await this.invalidate(id);
  }
}

async function closeManaged(managed: ManagedClient): Promise<void> {
  await managed.client.close().catch(() => {});
}

export function isMcpCapability(value: CapabilityDefinition): value is McpCapability {
  return value.kind === "mcp";
}

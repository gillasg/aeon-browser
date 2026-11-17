// The 2026-07-28 MCP revision: no initialize handshake, a per-request _meta envelope, and a
// resultType on every result. A client that sends initialize keeps the older result shapes, so an
// old client keeps working. Shared by Aeon's two stdio MCP servers.

export const MCP_MODERN_VERSION = "2026-07-28";
export const MCP_META_VERSION = "io.modelcontextprotocol/protocolVersion";
export const MCP_META_CLIENT = "io.modelcontextprotocol/clientInfo";
export const MCP_META_SERVER = "io.modelcontextprotocol/serverInfo";
/** OpenCode puts the calling agent's session id here, so parallel subagents get their own REPL. */
export const MCP_SESSION_META = "ai.opencode/sessionID";
/** Newest first; a pre-2026 client negotiates one of these through initialize. */
export const MCP_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

type Json = Record<string, unknown>;

export function mcpMeta(params: unknown): Json {
  if (!params || typeof params !== "object" || Array.isArray(params)) return {};
  const meta = (params as Json)._meta;
  return meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Json) : {};
}

export function mcpClientName(params: unknown, fallback = ""): string {
  const info = mcpMeta(params)[MCP_META_CLIENT];
  if (info && typeof info === "object" && !Array.isArray(info)) {
    const name = (info as Json).name;
    if (typeof name === "string" && name) return name;
  }
  return fallback;
}

/** The caller's session id from _meta, used as the default REPL session when no explicit one is given. */
export function mcpSessionFromMeta(params: unknown): string | undefined {
  const value = mcpMeta(params)[MCP_SESSION_META];
  return typeof value === "string" && value ? value : undefined;
}

/** An explicit session argument wins; else the caller's _meta session; else the legacy default. */
export function chooseMcpSession(
  explicit: unknown,
  defaultSession: string | undefined,
  fallback = "mcp",
): string {
  if (typeof explicit === "string" && explicit) return explicit;
  return defaultSession || fallback;
}

/** Modern when the request carries the modern version in _meta, or when it is the discover probe. */
export function isModernMcp(method: string, params: unknown): boolean {
  return method === "server/discover" || mcpMeta(params)[MCP_META_VERSION] === MCP_MODERN_VERSION;
}

export function mcpDiscoverResult(serverInfo: Json, instructions?: string, tools: Json = {}): Json {
  return {
    resultType: "complete",
    supportedVersions: [MCP_MODERN_VERSION, ...MCP_PROTOCOLS],
    capabilities: tools,
    ...(instructions === undefined ? {} : { instructions }),
    ttlMs: 0,
    cacheScope: "private",
    _meta: { [MCP_META_SERVER]: serverInfo },
  };
}

/** A modern list result carries the era's resultType and the cache hints its schema requires. */
export function mcpListResult(value: Json, modern: boolean): Json {
  if (!modern) return value;
  return { ...value, resultType: "complete", ttlMs: 0, cacheScope: "private" };
}

/** Any other modern result says resultType: complete. */
export function mcpResult(value: Json, modern: boolean): Json {
  if (!modern) return value;
  return { ...value, resultType: "complete" };
}

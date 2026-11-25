/**
 * The connected MCP tools as the code realm sees them: one clean slug per server (from its display
 * name), concise one-line refs, a capped listing and lexical search. Full schemas never leave the
 * daemon, so a model with 200 registered tools still gets a short answer.
 */

export const LIST_TOOL_CAP = 20;
export const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 50;
/** Names the realm's `mcp` object already uses; a server slug never shadows them. */
const RESERVED = new Set(["list", "search", "call", "then", "tojson", "constructor", "prototype"]);

export interface ToolRef {
  server: string;
  slug: string;
  name: string;
  description: string;
  inputKeys?: string[];
}

export interface IndexedServer {
  serverId: string;
  displayName: string;
  slug: string;
  tools: ToolRef[];
}

export interface ListedMcpServer {
  serverId?: unknown;
  displayName?: unknown;
  tools?: { name?: unknown; description?: unknown; inputSchema?: unknown }[];
}

export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/g, "");
}

/**
 * Slugs are assigned in server-id order, so the same registry always gives the same names: the
 * first server keeps `notion`, a second one with the same name becomes `notion_2`.
 */
export function assignSlugs(
  servers: { serverId: string; displayName: string }[],
): Map<string, string> {
  const slugs = new Map<string, string>();
  const taken = new Set<string>();
  const ids = new Set(servers.map((server) => server.serverId));
  for (const server of [...servers].sort((a, b) => a.serverId.localeCompare(b.serverId))) {
    let base =
      slugify(server.displayName) || slugify(server.serverId.replace(/^cap_/, "")) || "server";
    if (/^[0-9]/.test(base)) base = `s_${base}`;
    if (RESERVED.has(base) || (ids.has(base) && base !== server.serverId)) base = `${base}_mcp`;
    let slug = base;
    for (let n = 2; taken.has(slug); n += 1) slug = `${base}_${n}`;
    taken.add(slug);
    slugs.set(server.serverId, slug);
  }
  return slugs;
}

export function indexServers(listed: ListedMcpServer[]): IndexedServer[] {
  const valid = listed.filter(
    (server): server is ListedMcpServer & { serverId: string } =>
      !!server && typeof server.serverId === "string",
  );
  const named = valid.map((server) => ({
    serverId: server.serverId,
    displayName: typeof server.displayName === "string" ? server.displayName : "",
  }));
  const slugs = assignSlugs(named);
  return valid.map((server, index) => {
    const slug = slugs.get(server.serverId) ?? server.serverId;
    const tools: ToolRef[] = [];
    for (const tool of server.tools ?? []) {
      if (!tool || typeof tool.name !== "string") continue;
      const inputKeys = schemaKeys(tool.inputSchema);
      tools.push({
        server: slug,
        slug,
        name: tool.name,
        description: oneLine(typeof tool.description === "string" ? tool.description : ""),
        ...(inputKeys.length ? { inputKeys } : {}),
      });
    }
    return { serverId: server.serverId, displayName: named[index]?.displayName ?? "", slug, tools };
  });
}

export function listing(servers: IndexedServer[]): unknown {
  const all = servers.flatMap((server) => server.tools);
  const tools = all.slice(0, LIST_TOOL_CAP);
  const truncated = all.length > tools.length;
  return {
    servers: servers.map((server) => ({
      server: server.slug,
      serverId: server.serverId,
      displayName: server.displayName,
      toolCount: server.tools.length,
    })),
    totalTools: all.length,
    tools,
    truncated,
    hint: truncated
      ? `Showing ${tools.length} of ${all.length} tools. Use mcp.search(query) to find the right one, then mcp.<server>.<tool>(args).`
      : "Call mcp.<server>.<tool>(args). mcp.search(query) finds tools by purpose.",
  };
}

/** Lexical ranking over server name, slug, tool name and description; ties keep listing order. */
export function searchTools(servers: IndexedServer[], query: string, limit?: number): ToolRef[] {
  const terms = tokens(query);
  if (!terms.length) return [];
  const max = Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_SEARCH_LIMIT)), MAX_SEARCH_LIMIT);
  const scored: { ref: ToolRef; score: number; order: number }[] = [];
  let order = 0;
  for (const server of servers)
    for (const ref of server.tools) {
      const score = scoreTool(server, ref, terms, query);
      if (score > 0) scored.push({ ref, score, order });
      order += 1;
    }
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, Number.isFinite(max) ? max : DEFAULT_SEARCH_LIMIT)
    .map((item) => item.ref);
}

function scoreTool(server: IndexedServer, ref: ToolRef, terms: string[], query: string): number {
  const toolWords = tokens(ref.name);
  const serverWords = new Set([...tokens(server.displayName), ...tokens(server.slug)]);
  const descriptionWords = new Set(tokens(ref.description));
  const phrase = slugify(query);
  let score = phrase && slugify(ref.name) === phrase ? 12 : 0;
  for (const term of terms) {
    if (toolWords.includes(term)) score += 6;
    else if (toolWords.some((word) => word.startsWith(term) || term.startsWith(word))) score += 3;
    if (serverWords.has(term)) score += 4;
    if (descriptionWords.has(term)) score += 2;
    else if ([...descriptionWords].some((word) => word.startsWith(term))) score += 1;
  }
  return score;
}

function tokens(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 || /[0-9]/.test(word));
}

function schemaKeys(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  return Object.keys(properties).slice(0, 12);
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

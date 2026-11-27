import type { McpBridge } from "@graft/pi-adapter";
import type { McpClientManager } from "./mcp-client-manager.js";
import {
  indexServers,
  listing,
  searchTools,
  type IndexedServer,
  type ListedMcpServer,
  type ToolRef,
} from "./mcp-tool-index.js";

/** One MCP call inside a cell never waits longer than this, even if the run budget is longer. */
export const MCP_CALL_TIMEOUT_MS = 30_000;

type CallResult = {
  isError?: unknown;
  content?: { type?: unknown; text?: unknown }[];
  structuredContent?: unknown;
};

/**
 * The daemon's side of `mcp.<server>.<tool>(args)` inside browser_code. The manager owns the
 * real connections (and their 30 s discovery cache); this bridge owns the slug names, the capped
 * list, search, JSON in/out, error text, per-call timeout and cancellation. No Graft (browser) tool
 * is ever in the list, so mcp cannot recurse. `<server>` is the slug from the server's display
 * name (`notion`) or, as before, its capability id (`cap_...`).
 */
export class McpCodeBridge implements McpBridge {
  private servers: IndexedServer[] | undefined;
  /** slug.tool and serverId.tool -> the manager's (serverId, toolName). */
  private targets = new Map<string, { server: string; tool: string }>();

  constructor(private readonly manager: Pick<McpClientManager, "listMcpTools" | "callMcpTool">) {}

  async list(signal?: AbortSignal): Promise<unknown> {
    return listing(await this.refresh(signal));
  }

  async search(
    query: string,
    options: { limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<ToolRef[]> {
    const servers = this.servers ?? (await this.refresh(signal));
    return searchTools(servers, String(query ?? ""), options.limit);
  }

  async call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // Discovery is lazy: a script may call a tool without listing first. The manager's cache keeps
    // repeat listings cheap, and a server connected after the first listing is found by a fresh one.
    if (!this.servers) await this.refresh(signal);
    const name = `${server}.${tool}`;
    let target = this.targets.get(name);
    if (!target) {
      await this.refresh(signal);
      target = this.targets.get(name);
    }
    if (!target) throw new Error(this.unknownTool(name));
    const result = (await this.manager.callMcpTool(
      target.server,
      target.tool,
      args,
      withTimeout(signal),
    )) as CallResult;
    if (result?.isError === true) throw new Error(toolText(result));
    return toolValue(result);
  }

  private async refresh(signal?: AbortSignal): Promise<IndexedServer[]> {
    const reply = (await this.manager.listMcpTools(undefined, signal)) as {
      servers?: ListedMcpServer[];
    };
    const servers = indexServers(reply.servers ?? []);
    this.targets = new Map();
    for (const entry of servers)
      for (const ref of entry.tools) {
        const target = { server: entry.serverId, tool: ref.name };
        this.targets.set(`${entry.serverId}.${ref.name}`, target);
        this.targets.set(`${entry.slug}.${ref.name}`, target);
      }
    this.servers = servers;
    return servers;
  }

  private unknownTool(name: string): string {
    const all = (this.servers ?? []).flatMap((entry) => entry.tools);
    if (!all.length) return `no MCP tool named ${name}. No MCP tools are connected.`;
    const tool = name.slice(name.indexOf(".") + 1);
    const near = searchTools(this.servers ?? [], `${name} ${tool}`, 5);
    const shown = (near.length ? near : all.slice(0, 5)).map((ref) => `${ref.slug}.${ref.name}`);
    return `no MCP tool named ${name}. Closest: ${shown.join(", ")}. Use mcp.search(query) to find others.`;
  }
}

/** A cancelled call is never retried; the timeout only bounds how long one reply may take. */
function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(MCP_CALL_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function toolText(result: CallResult): string {
  const parts = (result.content ?? [])
    .filter((part) => part && (part.type === "text" || part.text !== undefined))
    .map((part) => String(part.text ?? ""));
  const text = parts.join("\n").trim();
  if (text) return text;
  return result.structuredContent === undefined
    ? "The MCP tool reported an error without a message."
    : JSON.stringify(result.structuredContent).slice(0, 2000);
}

function toolValue(result: CallResult): unknown {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = (result?.content ?? [])
    .filter((part) => part && part.text !== undefined)
    .map((part) => String(part.text ?? ""))
    .join("\n");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

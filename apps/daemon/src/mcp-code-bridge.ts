import type { McpBridge } from "@aeon/pi-adapter";
import type { McpClientManager } from "./mcp-client-manager.js";

/** One MCP call inside a cell never waits longer than this, even if the run budget is longer. */
export const MCP_CALL_TIMEOUT_MS = 30_000;

type ListedServer = {
  serverId?: unknown;
  tools?: { name?: unknown; description?: unknown }[];
};

type CallResult = {
  isError?: unknown;
  content?: { type?: unknown; text?: unknown }[];
  structuredContent?: unknown;
};

/**
 * The daemon's side of `mcp.<server>.<tool>(args)` inside browser_code. The manager owns the
 * real connections; this bridge owns the list/name check, JSON in/out, error text, per-call
 * timeout and cancellation. No Aeon (browser) tool is ever in the list, so mcp cannot recurse.
 */
export class McpCodeBridge implements McpBridge {
  private refs: { name: string; description: string }[] | undefined;
  /** server.tool -> the manager's (serverId, toolName), kept from discovery. */
  private targets = new Map<string, { server: string; tool: string }>();

  constructor(private readonly manager: McpClientManager) {}

  async list(signal?: AbortSignal): Promise<{ name: string; description: string }[]> {
    const reply = (await this.manager.listMcpTools(undefined, signal)) as {
      servers?: ListedServer[];
    };
    const refs: { name: string; description: string }[] = [];
    this.targets = new Map();
    for (const server of reply.servers ?? []) {
      if (!server || typeof server.serverId !== "string") continue;
      for (const tool of server.tools ?? []) {
        if (!tool || typeof tool.name !== "string") continue;
        const name = `${server.serverId}.${tool.name}`;
        refs.push({
          name,
          description: oneLine(typeof tool.description === "string" ? tool.description : ""),
        });
        this.targets.set(name, { server: server.serverId, tool: tool.name });
      }
    }
    this.refs = refs;
    return refs;
  }

  async call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // Discovery is lazy: a script may call a tool without calling mcp.list() first. listMcpTools
    // populates the manager's discovery cache that callMcpTool needs.
    if (!this.refs) await this.list(signal);
    const name = `${server}.${tool}`;
    const target = this.targets.get(name);
    if (!target) {
      const names = (this.refs ?? []).map((ref) => ref.name);
      throw new Error(
        `no MCP tool named ${name}. ${
          names.length ? `Available MCP tools: ${names.join(", ")}.` : "No MCP tools are connected."
        }`,
      );
    }
    const result = (await this.manager.callMcpTool(
      target.server,
      target.tool,
      args,
      withTimeout(signal),
    )) as CallResult;
    if (result?.isError === true) throw new Error(toolText(result));
    return toolValue(result);
  }
}

/** A cancelled call is never retried; the timeout only bounds how long one reply may take. */
function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(MCP_CALL_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
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

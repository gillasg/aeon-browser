// JSON-RPC and tool-result shapes the MCP server answers with.
import { rpcError } from "./mcp-resources.js";
import type { ChatResult } from "./results.js";

type Json = Record<string, unknown>;

export function text(value: unknown): {
  content: { type: string; text: string }[];
  isError: boolean;
} {
  return {
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
    isError: false,
  };
}

export function reply(id: unknown, result?: unknown, error?: unknown): Json {
  return error === undefined
    ? { jsonrpc: "2.0", id, result }
    : { jsonrpc: "2.0", id, error: rpcError(error) };
}

export function withoutTrace(result: ChatResult): Omit<ChatResult, "trace"> {
  const copy: Partial<ChatResult> = { ...result };
  delete copy.trace;
  return copy as Omit<ChatResult, "trace">;
}

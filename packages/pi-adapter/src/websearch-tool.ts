import { Type, type Static } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { boundedResult, textResult, type ToolText } from "./site-tool-output.js";

// websearch: one web search through Exa's hosted MCP endpoint, the same request OpenCode's
// websearch tool sends (MIT). It works without a key; EXA_API_KEY, when set, raises the limits.
// The endpoint answers JSON or an SSE stream; both carry a JSON-RPC result with text content.

export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
export const WEBSEARCH_TIMEOUT_MS = 25_000;
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const NO_RESULTS = "No search results found. Please try a different query.";

const Parameters = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 2000, description: "Websearch query" }),
    numResults: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50,
        description: "Number of search results to return (default: 8)",
      }),
    ),
    livecrawl: Type.Optional(
      Type.Union([Type.Literal("fallback"), Type.Literal("preferred")], {
        description:
          "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
      }),
    ),
    type: Type.Optional(
      Type.Union([Type.Literal("auto"), Type.Literal("fast"), Type.Literal("deep")], {
        description:
          "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
      }),
    ),
    contextMaxCharacters: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100_000,
        description: "Maximum characters for context string optimized for LLMs (default: 10000)",
      }),
    ),
  },
  { additionalProperties: false },
);
export type WebsearchInput = Static<typeof Parameters>;

export function websearchDescription(year = new Date().getFullYear()): string {
  return [
    "- Search the web - performs real-time web searches and can scrape content from specific URLs",
    "- Provides up-to-date information for current events and recent data",
    "- Supports configurable result counts and returns the content from the most relevant websites",
    "- Use this tool for accessing information beyond knowledge cutoff",
    "- Searches are performed automatically within a single API call",
    "",
    "Usage notes:",
    "  - Supports live crawling modes: 'fallback' (backup if cached unavailable) or 'preferred' (prioritize live crawling)",
    "  - Search types: 'auto' (balanced), 'fast' (quick results), 'deep' (comprehensive search)",
    "  - Configurable context length for optimal LLM integration",
    "",
    `The current year is ${year}. You MUST use this year when searching for recent information or current events`,
    `- Example: If the current year is ${year} and the user asks for "latest AI news", search for "AI news ${year}", NOT "AI news ${year - 1}"`,
  ].join("\n");
}

/** The JSON-RPC request OpenCode sends to Exa's MCP endpoint, with its defaults. */
export function exaRequest(input: WebsearchInput): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search_exa",
      arguments: {
        query: input.query,
        type: input.type ?? "auto",
        numResults: input.numResults ?? 8,
        livecrawl: input.livecrawl ?? "fallback",
        ...(input.contextMaxCharacters !== undefined
          ? { contextMaxCharacters: input.contextMaxCharacters }
          : {}),
      },
    },
  };
}

export function exaUrl(apiKey = process.env.EXA_API_KEY?.trim()): string {
  const url = new URL(EXA_MCP_URL);
  if (apiKey) url.searchParams.set("exaApiKey", apiKey);
  return url.toString();
}

function resultText(payload: string): string | undefined {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const message = value as {
    result?: { content?: { type?: string; text?: unknown }[]; isError?: boolean };
    error?: { message?: unknown };
  };
  if (message.error) {
    const text = typeof message.error.message === "string" ? message.error.message : "unknown";
    throw new Error(`Web search failed: ${text.slice(0, 300)}`);
  }
  const text = message.result?.content?.find(
    (item) => item.type === "text" && typeof item.text === "string" && item.text,
  )?.text as string | undefined;
  if (message.result?.isError && text) throw new Error(`Web search failed: ${text.slice(0, 300)}`);
  return text;
}

/** The first text result in a JSON body or an SSE stream of `data:` lines; undefined when none. */
export function parseExaResponse(body: string): string | undefined {
  const direct = resultText(body);
  if (direct) return direct;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const text = resultText(line.slice(6));
    if (text) return text;
  }
  return undefined;
}

async function boundedBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`web_search_exa response exceeded ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const HTTP_ERRORS = new Map([
  [429, "Web search rate limited (HTTP 429)"],
  [401, "Web search authentication failed (HTTP 401)"],
]);

async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return;
  await response.body?.cancel().catch(() => undefined);
  throw new Error(
    HTTP_ERRORS.get(response.status) ?? `Web search request failed (HTTP ${response.status})`,
  );
}

/** One search: the result text, or NO_RESULTS. Throws on HTTP errors, timeout and abort. */
export async function websearch(
  input: WebsearchInput,
  options: { signal?: AbortSignal; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? WEBSEARCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const response = await (options.fetch ?? fetch)(exaUrl(), {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(exaRequest(input)),
      signal,
    });
    await ensureOk(response);
    return parseExaResponse(await boundedBody(response)) ?? NO_RESULTS;
  } catch (error) {
    if (options.signal?.aborted) throw new Error("Web search was stopped.", { cause: error });
    if (timeout.aborted) throw new Error("Web search request timed out", { cause: error });
    throw error;
  }
}

export function createWebsearchTool(
  workingDirectory?: string,
  fetcher?: typeof fetch,
): ReturnType<typeof defineTool> {
  return defineTool({
    name: "websearch",
    label: "Web search",
    description: websearchDescription(),
    promptSnippet: "Use websearch for a quick web search with page content, without a browser.",
    parameters: Parameters,
    execute: async (_id, params, signal): Promise<ToolText> => {
      try {
        const text = await websearch(params, {
          ...(signal ? { signal } : {}),
          ...(fetcher ? { fetch: fetcher } : {}),
        });
        return boundedResult(text, workingDirectory, "websearch", params.query, "md");
      } catch (error) {
        return textResult({ error: error instanceof Error ? error.message : String(error) }, true);
      }
    },
  });
}

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { runMcpServer as runSiteMcpServer, siteName } from "@browserkit/tools/site-to-api";
import { AeonClient } from "./client.js";
import { inspect, runTasks } from "./run.js";
import type { ChatResult } from "./results.js";
import { searchAeon } from "./search.js";

// The Aeon MCP server (stdio). Another agent can hand Aeon tasks, watch them run as Chrome tabs,
// and read the answers and traces; or drive the browser itself with the tools Aeon's chats use
// (browser_code, browser_tabs, crawl, site_mapper, extract), as with browserkit. Runs start in the background and are polled, because a
// browser task can take far longer than an MCP client waits for one call.
type Json = Record<string, unknown>;
interface Run {
  total: number;
  chats: (string | undefined)[];
  results?: ChatResult[];
  error?: string;
}

const tools = [
  {
    name: "aeon_run",
    description:
      "Run tasks as Aeon chats. Each task becomes a full Aeon chat with browser control, opened as a background tab in the user's Chrome. Returns a runId at once; poll aeon_run_status for answers.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          maxItems: 100,
        },
        parallel: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Chats at once (default 5).",
        },
        quiet: { type: "boolean", description: "Do not open chat tabs." },
        model: { type: "string", description: "provider/id; default is Pi's default model." },
        thinking: { type: "string", description: "Thinking level; default is the model's." },
        timeoutMinutes: { type: "number", minimum: 1, maximum: 120 },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  },
  {
    name: "aeon_run_status",
    description:
      "Progress of an aeon_run: chat ids so far, and each task's answer and stats once done.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "aeon_result",
    description: "A chat's final answer and stats (tool calls, errors, tabs opened).",
    inputSchema: chatIdSchema(),
  },
  {
    name: "aeon_stop",
    description: "Stop a running Aeon chat and tidy the agent tabs it left open.",
    inputSchema: chatIdSchema(),
  },
  {
    name: "aeon_trace",
    description: "A chat's tool calls with the start of each result, in order, marking errors.",
    inputSchema: chatIdSchema(),
  },
  {
    name: "aeon_chats",
    description: "Recent Aeon chats (id and title).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
  },
  {
    name: "aeon_search",
    description: "Search Aeon chats (titles and messages) and the answers kept on home. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 200 },
        from: {
          type: "string",
          enum: ["user", "cli", "mcp", "companion", "agent", "routine", "unknown"],
        },
        since: { type: "string", description: "YYYY-MM-DD, by creation day." },
        until: { type: "string", description: "YYYY-MM-DD, by creation day." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "aeon_context",
    description:
      "The user's open tabs (title, URL) and which is active, when they allowed it in Aeon Settings. Titles and URLs only, never page contents. When it is off, returns how to turn it on.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "aeon_routine",
    description:
      "Create, list, pause or delete an Aeon routine (a scheduled agent task). Its alerts appear in Aeon, not here. Only routines this origin created are listed or changed.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "pause", "delete"] },
        routineId: { type: "string", maxLength: 100 },
        chatId: { type: "string", maxLength: 100 },
        title: { type: "string", maxLength: 120 },
        instruction: { type: "string", maxLength: 20000 },
        schedule: {
          description: 'A schedule object, or text such as "every 15 minutes".',
          anyOf: [{ type: "string", maxLength: 200 }, { type: "object" }],
        },
        check: { type: "string", maxLength: 20000 },
        sites: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 10 },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

const CHAT_TOOLS = new Set(["browser_code", "browser_tabs", "crawl", "site_mapper", "extract"]);

/** The chat tools, described by the daemon itself; none while Aeon is not running. */
async function chatTools(aeon: () => Promise<AeonClient>): Promise<unknown[]> {
  try {
    const reply = await (await aeon()).tool({ kind: "core.tool.list" }, 10_000);
    return Array.isArray(reply.tools) ? reply.tools : [];
  } catch {
    return [];
  }
}

async function callChatTool(client: AeonClient, name: string, args: Json = {}): Promise<unknown> {
  const { session, ...rest } = args;
  const reply = await client.tool({
    kind: "core.tool.call",
    tool: name,
    session: typeof session === "string" && session ? session : "mcp",
    arguments: rest,
  });
  return { content: reply.content, isError: reply.isError === true };
}

function chatIdSchema() {
  return {
    type: "object",
    properties: { chatId: { type: "string" } },
    required: ["chatId"],
    additionalProperties: false,
  };
}

/** aeon_search: chats, messages and saved answers, read-only. */
function searchTool(client: AeonClient, args: Json): Promise<unknown> {
  return searchAeon(
    client,
    String(args.text ?? ""),
    {
      ...(typeof args.from === "string" ? { origin: args.from } : {}),
      ...(typeof args.since === "string" ? { since: args.since } : {}),
      ...(typeof args.until === "string" ? { until: args.until } : {}),
    },
    Number(args.limit ?? 20),
  );
}

export async function runMcpServer(site?: string): Promise<void> {
  // One mapped site as its own MCP server: one tool per operation, called with the user's logins.
  if (site) return runSiteMcpServer(siteName(site));
  let client: AeonClient | undefined;
  const aeon = async () => (client ??= await AeonClient.connect());
  const runs = new Map<string, Run>();
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line) as Json;
    if (message.id === undefined) continue;
    try {
      reply(message.id, await handle(message, aeon, runs));
    } catch (error) {
      reply(message.id, undefined, error instanceof Error ? error.message : String(error));
    }
  }
  client?.close();
}

async function handle(
  message: Json,
  aeon: () => Promise<AeonClient>,
  runs: Map<string, Run>,
): Promise<unknown> {
  if (message.method === "initialize")
    return {
      protocolVersion: (message.params as Json | undefined)?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "aeon", version: "0.1.0" },
    };
  if (message.method === "tools/list") return { tools: [...tools, ...(await chatTools(aeon))] };
  if (message.method === "ping") return {};
  if (message.method !== "tools/call") throw new Error("Method not found");
  const params = message.params as { name: string; arguments?: Json };
  if (CHAT_TOOLS.has(params.name)) return callChatTool(await aeon(), params.name, params.arguments);
  try {
    return text(await callTool(params.name, params.arguments ?? {}, aeon, runs));
  } catch (error) {
    return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
  }
}

async function callTool(
  name: string,
  args: Json,
  aeon: () => Promise<AeonClient>,
  runs: Map<string, Run>,
): Promise<unknown> {
  const client = await aeon();
  if (name === "aeon_stop") return { stopped: await client.stop(String(args.chatId)) };
  if (name === "aeon_run" || name === "aeon_run_status") return runTool(client, name, args, runs);
  if (["aeon_chats", "aeon_search", "aeon_context", "aeon_routine"].includes(name))
    return chatTool(client, name, args);
  return inspectTool(client, name, args);
}

function runTool(
  client: AeonClient,
  name: string,
  args: Json,
  runs: Map<string, Run>,
): { runId: string } | Record<string, unknown> {
  if (name === "aeon_run") return startRun(client, args, runs);
  const run = runs.get(String(args.runId));
  if (!run) throw new Error("Unknown runId");
  return run.results
    ? { done: true, results: run.results.map(withoutTrace) }
    : {
        done: false,
        error: run.error,
        started: run.chats.filter(Boolean).length,
        total: run.total,
        chats: run.chats,
      };
}

async function chatTool(client: AeonClient, name: string, args: Json): Promise<unknown> {
  if (name === "aeon_chats")
    return (await client.command("chat.list", { limit: Number(args.limit ?? 20) })).chats;
  if (name === "aeon_search") return searchTool(client, args);
  if (name === "aeon_context") return toolValue(client, "context", {}, "context");
  return toolValue(client, "routine", args, "routine");
}

async function toolValue(
  client: AeonClient,
  tool: string,
  args: Json,
  label: string,
): Promise<unknown> {
  const reply = await client.tool({
    kind: "core.tool.call",
    tool,
    session: "mcp",
    arguments: args,
  });
  const output = ((reply.content as { text?: string }[] | undefined) ?? [])
    .map((part) => part.text ?? "")
    .join("");
  if (reply.isError === true) throw new Error(output || `The ${label} command failed.`);
  return JSON.parse(output || "null") as unknown;
}

async function inspectTool(client: AeonClient, name: string, args: Json): Promise<unknown> {
  const result = await inspect(client, String(args.chatId));
  if (name === "aeon_trace") return result.trace;
  if (name === "aeon_result") return withoutTrace(result);
  throw new Error("Unknown tool " + name);
}

function startRun(client: AeonClient, args: Json, runs: Map<string, Run>): { runId: string } {
  const tasks = (args.tasks as string[]).filter((task) => typeof task === "string" && task.trim());
  const runId = randomUUID();
  const run: Run = { total: tasks.length, chats: new Array<string | undefined>(tasks.length) };
  runs.set(runId, run);
  const [provider, ...id] = String(args.model ?? "").split("/");
  void runTasks(client, tasks, {
    parallel: Number(args.parallel ?? 5),
    quiet: args.quiet === true,
    origin: "mcp",
    ...(provider && id.length ? { model: { provider, id: id.join("/") } } : {}),
    ...(typeof args.thinking === "string" ? { thinkingLevel: args.thinking } : {}),
    timeoutMs: Number(args.timeoutMinutes ?? 20) * 60_000,
    onStarted: (index, chatId) => (run.chats[index] = chatId),
  }).then(
    (results) => (run.results = results),
    (error: unknown) => (run.error = error instanceof Error ? error.message : String(error)),
  );
  return { runId };
}

function text(value: unknown) {
  return {
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
    isError: false,
  };
}

function reply(id: unknown, result?: unknown, error?: string): void {
  process.stdout.write(
    JSON.stringify(
      error === undefined
        ? { jsonrpc: "2.0", id, result }
        : { jsonrpc: "2.0", id, error: { code: -32603, message: error } },
    ) + "\n",
  );
}

function withoutTrace(result: ChatResult): Omit<ChatResult, "trace"> {
  const copy: Partial<ChatResult> = { ...result };
  delete copy.trace;
  return copy as Omit<ChatResult, "trace">;
}

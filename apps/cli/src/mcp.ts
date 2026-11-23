import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { runMcpServer as runSiteMcpServer, siteName } from "@browserkit/tools/site-to-api";
import { AeonClient } from "./client.js";
import {
  browserActionCode,
  browserActionDescription,
  browserActionSchema,
} from "@browserkit/tools/action";
import { inspect, runTasks, type RunOptions } from "./run.js";
import type { ChatResult } from "./results.js";
import { searchAeon } from "./search.js";
import { answer, questions, send, waitForChange } from "./converse.js";
import {
  MCP_PROTOCOLS,
  chooseMcpSession,
  isModernMcp,
  mcpDiscoverResult,
  mcpListResult,
  mcpResult,
  mcpSessionFromMeta,
} from "@aeon/protocol";
import { modelAuthPath, modelSignedIn } from "./doctor-io.js";
import { SamplingBridge, readUseClientModel, setSamplingBridge } from "./mcp-sampling.js";
import {
  callCatalog,
  catalogFingerprint,
  catalogMcpTool,
  loadCatalog,
  type CatalogTool,
} from "./catalog.js";
import {
  createExtensions,
  extensionCapabilities,
  handleExtension,
  taskAugmentedCall,
  type McpExtensions,
} from "./mcp-extensions.js";

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
        budget: {
          type: "object",
          description:
            "Limits per chat; when one is reached the agent stops using tools and answers with what it has.",
          properties: {
            maxSteps: { type: "integer", minimum: 1, maximum: 10000 },
            maxMinutes: { type: "number", minimum: 0.1, maximum: 1440 },
            maxCost: { type: "number", minimum: 0.001, maximum: 1000 },
          },
          additionalProperties: false,
        },
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
    name: "aeon_send",
    description:
      "Send another message into an existing Aeon chat. While the chat works, it waits as a follow-up (steer: true changes the current turn instead); when idle, it starts a new turn. Then use aeon_wait.",
    inputSchema: {
      type: "object",
      properties: {
        chatId: { type: "string" },
        message: { type: "string", minLength: 1, maxLength: 50000 },
        steer: { type: "boolean" },
      },
      required: ["chatId", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "aeon_answer",
    description:
      "Answer the question an Aeon chat's agent is waiting on (aeon_wait and aeon_run_status list them). confirm: yes or no; select: one of its choices or its number; input: any text.",
    inputSchema: {
      type: "object",
      properties: {
        chatId: { type: "string" },
        answer: { type: "string", maxLength: 20000 },
        questionId: { type: "string", description: "Only when several are pending." },
      },
      required: ["chatId", "answer"],
      additionalProperties: false,
    },
  },
  {
    name: "aeon_wait",
    description:
      "Wait until an Aeon chat changes: new steps after `since`, a question for you, or it finishes (then its answer). Returns steps (pass back as since), newSteps, questions, working and answer; changed is false on timeout.",
    inputSchema: {
      type: "object",
      properties: {
        chatId: { type: "string" },
        since: { type: "integer", minimum: 0, description: "Steps already seen; default now." },
        timeoutSeconds: { type: "number", minimum: 1, maximum: 600, description: "Default 50." },
      },
      required: ["chatId"],
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
        webhook: { type: "string", maxLength: 2000 },
        webhookSecret: { type: "string", maxLength: 200 },
        webhookOnly: { type: "boolean" },
        browser: { type: "string", maxLength: 80 },
        effect: { type: "string", enum: ["read", "write", "irreversible"] },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "catalog_search",
    description:
      "Find mapped site operations and saved abilities by text. Each match is a tool this server also lists.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "browser_action",
    description: browserActionDescription,
    inputSchema: browserActionSchema,
  },
];

const CHAT_TOOLS = new Set([
  "browser_code",
  "browser_tabs",
  "browser_context",
  "crawl",
  "site_mapper",
  "extract",
  "browser_action",
]);

/** The chat tools, described by the daemon itself; none while Aeon is not running. */
async function chatTools(aeon: () => Promise<AeonClient>): Promise<unknown[]> {
  try {
    const reply = await (await aeon()).tool({ kind: "core.tool.list" }, 10_000);
    return Array.isArray(reply.tools) ? reply.tools : [];
  } catch {
    return [];
  }
}

async function callChatTool(
  client: AeonClient,
  name: string,
  args: Json = {},
  defaultSession = "mcp",
  signal?: AbortSignal,
): Promise<unknown> {
  const { session, ...rest } = args;
  // An explicit session argument always wins; the caller's _meta session is the default so
  // parallel subagents of one client do not share a REPL.
  const chosen = chooseMcpSession(session, defaultSession);
  // One discrete action is one browser_code cell; the tool lists and the semantics are shared.
  if (name === "browser_action")
    return callChatTool(
      client,
      "browser_code",
      { ...(chosen ? { session: chosen } : {}), code: browserActionCode(rest as never) },
      defaultSession,
      signal,
    );
  const reply = await client.tool(
    {
      kind: "core.tool.call",
      tool: name,
      session: chosen,
      arguments: rest,
    },
    undefined,
    signal,
  );
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

interface McpConnection {
  modern: boolean;
}
interface McpDeps {
  aeon: () => Promise<AeonClient>;
  runs: Map<string, Run>;
  pending: Map<string, AbortController>;
  conn: McpConnection;
}

function mcpParams(message: Json): Json {
  return message.params && typeof message.params === "object" && !Array.isArray(message.params)
    ? (message.params as Json)
    : {};
}

/** Learn the caller's identity from a 2026-07-28 request, or fall back to the older handshake. */
function learnConnection(params: Json, method: string, conn: McpConnection): void {
  if (isModernMcp(method, params)) conn.modern = true;
  if (method === "initialize") conn.modern = false;
}

function cancelMcpCall(
  message: Json,
  params: Json,
  pending: Map<string, AbortController>,
  sampler: SamplingBridge,
): void {
  // Notifications need no answer. A 2026-07-28 cancel stops the in-flight call; its answer is
  // dropped, so a cancelled write is never replayed. The same id may be a sampling request.
  if (message.method === "notifications/cancelled" && params.requestId !== undefined) {
    const id = String(params.requestId);
    pending.get(id)?.abort();
    sampler.abort(id);
  }
}

/** A tool call runs without blocking the read loop, so a cancel can arrive while it is in flight. */
async function answerCall(
  message: Json,
  id: unknown,
  deps: McpDeps,
  modern: boolean,
  session: string | undefined,
): Promise<void> {
  const controller = new AbortController();
  const key = String(id);
  deps.pending.set(key, controller);
  try {
    const result = await handle(message, deps.aeon, deps.runs, modern, session, controller.signal);
    if (!controller.signal.aborted) reply(id, mcpResult(result as Json, modern));
  } catch (error) {
    if (!controller.signal.aborted)
      reply(id, undefined, error instanceof Error ? error.message : String(error));
  } finally {
    if (deps.pending.get(key) === controller) deps.pending.delete(key);
  }
}

async function answerRequest(
  message: Json,
  id: unknown,
  deps: McpDeps,
  modern: boolean,
  session: string | undefined,
): Promise<void> {
  try {
    const result = await handle(message, deps.aeon, deps.runs, modern, session);
    reply(id, mcpResult(result as Json, modern));
  } catch (error) {
    reply(id, undefined, error instanceof Error ? error.message : String(error));
  }
}

export async function runMcpServer(site?: string): Promise<void> {
  // One mapped site as its own MCP server: one tool per operation, called with the user's logins.
  if (site) return runSiteMcpServer(siteName(site));
  let client: AeonClient | undefined;
  catalogState = { tools: [], fingerprint: "", primed: false };
  const stopCatalog = watchCatalog();
  const deps: McpDeps = {
    aeon: async () => (client ??= await AeonClient.connect()),
    runs: new Map<string, Run>(),
    pending: new Map<string, AbortController>(),
    conn: { modern: false },
  };
  // A model call is routed to the agent when it offered sampling and Aeon has no model of its own,
  // or the user asked to prefer the agent's model. Both facts are read once, here at session start.
  const sampler = new SamplingBridge();
  sampler.setSender((request) => process.stdout.write(`${JSON.stringify(request)}\n`));
  sampler.setUseClientModel(
    (await readUseClientModel()) || !(await modelSignedIn(modelAuthPath())),
  );
  setSamplingBridge(sampler);
  extensions = createExtensions(
    (method, params) =>
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`),
    (name, args, signal) =>
      callToolResult({ name, arguments: args }, deps.aeon, deps.runs, undefined, signal),
    () => catalogState.tools,
  );
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) await processMcpLine(line, deps, sampler);
  stopCatalog();
  extensions?.close();
  extensions = undefined;
  for (const controller of deps.pending.values()) controller.abort();
  sampler.close();
  setSamplingBridge(undefined);
  client?.close();
}

/** One stdin line: a client request, a notification, or a reply to our own sampling request. */
async function processMcpLine(line: string, deps: McpDeps, sampler: SamplingBridge): Promise<void> {
  if (!line.trim()) return;
  let message: Json;
  try {
    message = JSON.parse(line) as Json;
  } catch {
    reply(null, undefined, "Parse error");
    return;
  }
  const params = mcpParams(message);
  // A reply to one of our own sampling/createMessage requests is not a client request.
  if (message.id !== undefined && sampler.receive(String(message.id), message)) return;
  if (message.id === undefined) {
    cancelMcpCall(message, params, deps.pending, sampler);
    return;
  }
  const method = String(message.method ?? "");
  learnConnection(params, method, deps.conn);
  sampler.learnCapabilities(params);
  const modern = deps.conn.modern;
  const session = mcpSessionFromMeta(params);
  if (method === "tools/call" || method === "tasks/result")
    void answerCall(message, message.id, deps, modern, session);
  else await answerRequest(message, message.id, deps, modern, session);
}

function initializeResult(params: Json): Json {
  const asked = params.protocolVersion;
  const version = MCP_PROTOCOLS.find((candidate) => candidate === asked) ?? MCP_PROTOCOLS[0];
  return {
    protocolVersion: version,
    capabilities: { tools: { listChanged: true }, ...extensionCapabilities() },
    serverInfo: { name: "aeon", version: "0.1.0" },
  };
}

function listResult(method: string, modern: boolean): Json {
  return mcpListResult(method === "resources/list" ? { resources: [] } : { prompts: [] }, modern);
}

async function callToolResult(
  params: { name: string; arguments?: Json },
  aeon: () => Promise<AeonClient>,
  runs: Map<string, Run>,
  session: string | undefined,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  if (params.name === "catalog_search" || params.name.startsWith("site__")) {
    try {
      return text(await callCatalog(params.name, params.arguments ?? {}, catalogState.tools));
    } catch (error) {
      return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
    }
  }
  if (CHAT_TOOLS.has(params.name))
    return callChatTool(await aeon(), params.name, params.arguments, session, signal);
  try {
    return text(await callTool(params.name, params.arguments ?? {}, aeon, runs, session, signal));
  } catch (error) {
    return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
  }
}

async function handle(
  message: Json,
  aeon: () => Promise<AeonClient>,
  runs: Map<string, Run>,
  modern = false,
  session?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const method = String(message.method ?? "");
  if (method === "initialize") return initializeResult(mcpParams(message));
  if (method === "server/discover") return mcpDiscoverResult({ name: "aeon", version: "0.1.0" });
  if (method === "tools/list") {
    const listed = await refreshCatalog(false);
    return mcpListResult(
      { tools: [...tools, ...listed.map(catalogMcpTool), ...(await chatTools(aeon))] },
      modern,
    );
  }
  if (method === "resources/list" || method === "prompts/list") return listResult(method, modern);
  if (method === "ping") return mcpResult({}, modern);
  const extended = extensionRequest(method, mcpParams(message));
  if (extended) return extended;
  if (method !== "tools/call") throw new Error("Method not found");
  return callToolResult(
    message.params as { name: string; arguments?: Json },
    aeon,
    runs,
    session,
    signal,
  );
}

/** events/*, tasks/*, or a tools/call that asked to run as a task. */
function extensionRequest(method: string, params: Json): Promise<Json> | undefined {
  if (!extensions) return undefined;
  if (method === "tools/call") return taskAugmentedCall(extensions, params);
  return handleExtension(extensions, method, params);
}

async function callTool(
  name: string,
  args: Json,
  aeon: () => Promise<AeonClient>,
  runs: Map<string, Run>,
  defaultSession?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const client = await aeon();
  if (name === "aeon_stop") return { stopped: await client.stop(String(args.chatId)) };
  if (name === "aeon_run" || name === "aeon_run_status") return runTool(client, name, args, runs);
  if (["aeon_send", "aeon_answer", "aeon_wait"].includes(name))
    return converseTool(client, name, args);
  if (["aeon_chats", "aeon_search", "aeon_context", "aeon_routine"].includes(name))
    return chatTool(client, name, args, defaultSession, signal);
  return inspectTool(client, name, args);
}

async function runTool(
  client: AeonClient,
  name: string,
  args: Json,
  runs: Map<string, Run>,
): Promise<{ runId: string } | Record<string, unknown>> {
  if (name === "aeon_run") return startRun(client, args, runs);
  const run = runs.get(String(args.runId));
  if (!run) throw new Error("Unknown runId");
  if (run.results) return { done: true, results: run.results.map(withoutTrace) };
  return {
    done: false,
    error: run.error,
    started: run.chats.filter(Boolean).length,
    total: run.total,
    chats: run.chats,
    waiting: await waitingChats(client, run.chats),
  };
}

/** The run's chats whose agent is waiting on a question, with the questions (answer with aeon_answer). */
async function waitingChats(client: AeonClient, chats: (string | undefined)[]): Promise<Json[]> {
  const asked = await Promise.all(
    chats
      .filter((chatId): chatId is string => !!chatId)
      .map(async (chatId) => ({
        chatId,
        questions: await questions(client, chatId).catch(() => []),
      })),
  );
  return asked.filter((item) => item.questions.length > 0);
}

async function converseTool(client: AeonClient, name: string, args: Json): Promise<unknown> {
  const chatId = String(args.chatId);
  if (name === "aeon_send")
    return send(client, chatId, String(args.message), { steer: args.steer === true });
  if (name === "aeon_answer")
    return answer(
      client,
      chatId,
      String(args.answer),
      typeof args.questionId === "string" ? args.questionId : undefined,
    );
  return waitForChange(client, chatId, {
    ...(typeof args.since === "number" ? { since: args.since } : {}),
    timeoutMs: Number(args.timeoutSeconds ?? 50) * 1000,
  });
}

async function chatTool(
  client: AeonClient,
  name: string,
  args: Json,
  defaultSession?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (name === "aeon_chats")
    return (await client.command("chat.list", { limit: Number(args.limit ?? 20) })).chats;
  if (name === "aeon_search") return searchTool(client, args);
  if (name === "aeon_context")
    return toolValue(client, "context", {}, "context", defaultSession, signal);
  return toolValue(client, "routine", args, "routine", defaultSession, signal);
}

async function toolValue(
  client: AeonClient,
  tool: string,
  args: Json,
  label: string,
  defaultSession = "mcp",
  signal?: AbortSignal,
): Promise<unknown> {
  const reply = await client.tool(
    {
      kind: "core.tool.call",
      tool,
      session: chooseMcpSession(args.session, defaultSession),
      arguments: args,
    },
    undefined,
    signal,
  );
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
    ...(args.budget && typeof args.budget === "object"
      ? { budget: args.budget as NonNullable<RunOptions["budget"]> }
      : {}),
    onStarted: (index, chatId) => (run.chats[index] = chatId),
  }).then(
    (results) => (run.results = results),
    (error: unknown) => (run.error = error instanceof Error ? error.message : String(error)),
  );
  return { runId };
}

interface CatalogState {
  tools: CatalogTool[];
  fingerprint: string;
  primed: boolean;
}

let extensions: McpExtensions | undefined;
let catalogState: CatalogState = { tools: [], fingerprint: "", primed: false };

function watchCatalog(): () => void {
  const ms = Number(process.env.AEON_CATALOG_POLL_MS ?? 5000);
  const interval = Number.isFinite(ms) && ms >= 50 ? ms : 5000;
  const timer = setInterval(() => void refreshCatalog(true).catch(() => undefined), interval);
  timer.unref();
  return () => clearInterval(timer);
}

async function refreshCatalog(notify: boolean): Promise<CatalogTool[]> {
  const next = await loadCatalog();
  const fingerprint = catalogFingerprint(next);
  if (notify && catalogState.primed && fingerprint !== catalogState.fingerprint)
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`,
    );
  catalogState = { tools: next, fingerprint, primed: true };
  return next;
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

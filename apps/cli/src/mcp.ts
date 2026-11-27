import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { runMcpServer as runSiteMcpServer, siteName } from "@browserkit/tools/site-to-api";
import { GraftClient } from "./client.js";
import {
  browserActionCode,
  browserActionDescription,
  browserActionSchema,
} from "@browserkit/tools/action";
import { inspect, runTasks, type RunOptions } from "./run.js";
import type { ChatResult } from "./results.js";
import { searchGraft } from "./search.js";
import { answer, questions, send, waitForChange } from "./converse.js";
import {
  MCP_PROTOCOLS,
  chooseMcpSession,
  isModernMcp,
  mcpDiscoverResult,
  mcpListResult,
  mcpResult,
  mcpSessionFromMeta,
} from "@graft/protocol";
import { modelAuthPath, modelSignedIn } from "./doctor-io.js";
import { SamplingBridge, readUseClientModel, setSamplingBridge } from "./mcp-sampling.js";
import {
  catalogFingerprint,
  callCatalogResult,
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
import type { TaskContext } from "./mcp-tasks.js";
import { CODE_SURFACE_NAMES, CODE_SURFACE_TOOLS, ParkingLot } from "./mcp-code-mode.js";
import { codeSurfaceCall } from "./mcp-code-tools.js";
import { RESOURCES, resourceRequest, watchSkills } from "./mcp-resources.js";
import { reply, text, withoutTrace } from "./mcp-reply.js";

// The Graft MCP server (stdio). Another agent can hand Graft tasks, watch them run as Chrome tabs,
// and read the answers and traces; or drive the browser itself with the tools Graft's chats use
// (browser_code, browser_tabs, crawl, site_mapper, extract), as with browserkit. Runs start in the background and are polled, because a
// browser task can take far longer than an MCP client waits for one call.
type Json = Record<string, unknown>;
export interface Run {
  total: number;
  chats: (string | undefined)[];
  results?: ChatResult[];
  error?: string;
}

const tools = [
  {
    name: "graft_run",
    description:
      "Run tasks as Graft chats. Each task becomes a full Graft chat with browser control, opened as a background tab in the user's Chrome. Returns a runId at once; poll graft_run_status for answers.",
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
    name: "graft_run_status",
    description:
      "Progress of a graft_run: chat ids so far, and each task's answer and stats once done.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "graft_send",
    description:
      "Send another message into an existing Graft chat. While the chat works, it waits as a follow-up (steer: true changes the current turn instead); when idle, it starts a new turn. Then use graft_wait.",
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
    name: "graft_answer",
    description:
      "Answer the question a Graft chat's agent is waiting on (graft_wait and graft_run_status list them). confirm: yes or no; select: one of its choices or its number; input: any text.",
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
    name: "graft_wait",
    description:
      "Wait until a Graft chat changes: new steps after `since`, a question for you, or it finishes (then its answer). Returns steps (pass back as since), newSteps, questions, working and answer; changed is false on timeout.",
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
    name: "graft_result",
    description: "A chat's final answer and stats (tool calls, errors, tabs opened).",
    inputSchema: chatIdSchema(),
  },
  {
    name: "graft_stop",
    description: "Stop a running Graft chat and tidy the agent tabs it left open.",
    inputSchema: chatIdSchema(),
  },
  {
    name: "graft_trace",
    description: "A chat's tool calls with the start of each result, in order, marking errors.",
    inputSchema: chatIdSchema(),
  },
  {
    name: "graft_chats",
    description: "Recent Graft chats (id and title).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
  },
  {
    name: "graft_search",
    description: "Search Graft chats (titles, messages) and the answers kept on home. Read-only.",
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
    name: "graft_context",
    description:
      "The user's open tabs (title, URL) and which is active, when they allowed it in Graft Settings. Titles and URLs only, never page contents. When it is off, returns how to turn it on.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "graft_routine",
    description:
      "Create, list, pause or delete a Graft routine (a scheduled agent task). Its alerts appear in Graft, not here. Only routines this origin created are listed or changed.",
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

/** The chat tools, described by the daemon itself; none while Graft is not running. */
async function chatTools(graft: () => Promise<GraftClient>): Promise<unknown[]> {
  try {
    const reply = await (await graft()).tool({ kind: "core.tool.list" }, 10_000);
    return Array.isArray(reply.tools) ? reply.tools : [];
  } catch {
    return [];
  }
}

async function callChatTool(
  client: GraftClient,
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

/** graft_search: chats, messages and saved answers, read-only. */
function searchTool(client: GraftClient, args: Json): Promise<unknown> {
  return searchGraft(
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
/** `code` (default): the five fixed tools. `full`: every tool, one per mapped operation too. */
export type McpSurface = "code" | "full";
type Send = (message: Json) => void;
const stdoutSend: Send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
/** Where notifications and our own requests go: stdout, or the HTTP event streams. */
let notifySend: Send = stdoutSend;
let surface: McpSurface = "code";
let parking = new ParkingLot();
interface McpDeps {
  graft: () => Promise<GraftClient>;
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
  send: Send,
): Promise<void> {
  const controller = new AbortController();
  const key = String(id);
  deps.pending.set(key, controller);
  try {
    const result = await handle(message, deps.graft, deps.runs, modern, session, controller.signal);
    if (!controller.signal.aborted) send(reply(id, mcpResult(result as Json, modern)));
  } catch (error) {
    if (!controller.signal.aborted)
      send(reply(id, undefined, error instanceof Error ? error.message : String(error)));
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
  send: Send,
): Promise<void> {
  try {
    const result = await handle(message, deps.graft, deps.runs, modern, session);
    send(reply(id, mcpResult(result as Json, modern)));
  } catch (error) {
    send(reply(id, undefined, error));
  }
}

export interface McpServerOptions {
  surface?: McpSurface;
}

/** A started server: feed it client messages, then close it. Used by stdio and HTTP alike. */
export interface McpSession {
  /** One client message; `send` gets its reply (none for a notification). */
  receive(message: Json, send: Send): Promise<void>;
  close(): Promise<void>;
}

export async function runMcpServer(site?: string, options: McpServerOptions = {}): Promise<void> {
  // One mapped site as its own MCP server: one tool per operation, called with the user's logins.
  if (site) return runSiteMcpServer(siteName(site));
  const server = await startMcpServer(options, stdoutSend);
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      stdoutSend({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    await server.receive(message, stdoutSend);
  }
  await server.close();
}

/** Starts the shared server state; `notify` carries notifications and our sampling requests. */
export async function startMcpServer(options: McpServerOptions, notify: Send): Promise<McpSession> {
  surface = options.surface ?? "code";
  notifySend = notify;
  parking = new ParkingLot();
  let client: GraftClient | undefined;
  catalogState = { tools: [], fingerprint: "", primed: false };
  const stopCatalog = watchCatalog();
  void catalogReady();
  const stopSkills = watchSkills((message) => notifySend(message));
  const deps: McpDeps = {
    graft: async () => (client ??= await GraftClient.connect()),
    runs: new Map<string, Run>(),
    pending: new Map<string, AbortController>(),
    conn: { modern: false },
  };
  // Sampling goes to the agent when it offered it and Graft has no model, or the user prefers it.
  const sampler = new SamplingBridge();
  sampler.setSender((request) => notifySend(request as Json));
  sampler.setUseClientModel(
    (await readUseClientModel()) || !(await modelSignedIn(modelAuthPath())),
  );
  setSamplingBridge(sampler);
  extensions = createExtensions(
    (method, params) => notifySend({ jsonrpc: "2.0", method, params }),
    (name, args, signal, context) =>
      callToolResult({ name, arguments: args }, deps.graft, deps.runs, undefined, signal, context),
    () => catalogState.tools,
    deps.graft,
  );
  return {
    receive: (message, send) => processMcpMessage(message, deps, sampler, send),
    close: async () => {
      stopCatalog();
      stopSkills();
      await extensions?.close().catch(() => undefined);
      extensions = undefined;
      for (const controller of deps.pending.values()) controller.abort();
      sampler.close();
      setSamplingBridge(undefined);
      client?.close();
    },
  };
}

/** One client message: a request, a notification, or a reply to our own sampling request. */
async function processMcpMessage(
  message: Json,
  deps: McpDeps,
  sampler: SamplingBridge,
  send: Send,
): Promise<void> {
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
    void answerCall(message, message.id, deps, modern, session, send);
  else await answerRequest(message, message.id, deps, modern, session, send);
}

function initializeResult(params: Json): Json {
  const asked = params.protocolVersion;
  const version = MCP_PROTOCOLS.find((candidate) => candidate === asked) ?? MCP_PROTOCOLS[0];
  return {
    protocolVersion: version,
    capabilities: { tools: { listChanged: true }, ...RESOURCES, ...extensionCapabilities() },
    serverInfo: { name: "graft", version: "0.1.0" },
  };
}

function codeCall(
  params: { name: string; arguments?: Json },
  graft: () => Promise<GraftClient>,
  runs: Map<string, Run>,
  session: string | undefined,
  signal: AbortSignal | undefined,
  context: TaskContext | undefined,
): Promise<unknown> {
  return codeSurfaceCall(params.name, params.arguments ?? {}, {
    graft,
    parking,
    catalog: () => catalogState.tools,
    catalogReady,
    session: session ?? "mcp",
    startRun: async (args) => startRun(await graft(), args, runs),
    runs,
    callChat: async (name, args, cellSignal) =>
      callChatTool(await graft(), name, args, session, cellSignal),
    ...(signal ? { signal } : {}),
    ...(context ? { context } : {}),
  });
}

async function callToolResult(
  params: { name: string; arguments?: Json },
  graft: () => Promise<GraftClient>,
  runs: Map<string, Run>,
  session: string | undefined,
  signal: AbortSignal | undefined,
  context?: TaskContext,
): Promise<unknown> {
  if (surface === "code" && CODE_SURFACE_NAMES.has(params.name))
    return codeCall(params, graft, runs, session, signal, context);
  if (params.name === "catalog_search" || params.name.startsWith("site__")) {
    try {
      return await callCatalogResult(params.name, params.arguments ?? {}, catalogState.tools);
    } catch (error) {
      return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
    }
  }
  if (CHAT_TOOLS.has(params.name))
    return callChatTool(await graft(), params.name, params.arguments, session, signal);
  try {
    return text(await callTool(params.name, params.arguments ?? {}, graft, runs, session, signal));
  } catch (error) {
    return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
  }
}

async function handle(
  message: Json,
  graft: () => Promise<GraftClient>,
  runs: Map<string, Run>,
  modern = false,
  session?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const method = String(message.method ?? "");
  if (method === "initialize") return initializeResult(mcpParams(message));
  if (method === "server/discover") return mcpDiscoverResult({ name: "graft", version: "0.1.0" });
  if (method === "tools/list") {
    if (surface === "code") return mcpListResult({ tools: CODE_SURFACE_TOOLS }, modern);
    const listed = await refreshCatalog(false);
    return mcpListResult(
      { tools: [...tools, ...listed.map(catalogMcpTool), ...(await chatTools(graft))] },
      modern,
    );
  }
  const resource = resourceRequest(method, mcpParams(message), modern);
  if (resource) return resource;
  if (method === "ping") return mcpResult({}, modern);
  const extended = extensionRequest(method, mcpParams(message));
  if (extended) return extended;
  if (method !== "tools/call")
    throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  return callToolResult(
    message.params as { name: string; arguments?: Json },
    graft,
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
  graft: () => Promise<GraftClient>,
  runs: Map<string, Run>,
  defaultSession?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const client = await graft();
  if (name === "graft_stop") return { stopped: await client.stop(String(args.chatId)) };
  if (name === "graft_run" || name === "graft_run_status") return runTool(client, name, args, runs);
  if (["graft_send", "graft_answer", "graft_wait"].includes(name))
    return converseTool(client, name, args);
  if (["graft_chats", "graft_search", "graft_context", "graft_routine"].includes(name))
    return chatTool(client, name, args, defaultSession, signal);
  return inspectTool(client, name, args);
}

async function runTool(
  client: GraftClient,
  name: string,
  args: Json,
  runs: Map<string, Run>,
): Promise<{ runId: string } | Record<string, unknown>> {
  if (name === "graft_run") return startRun(client, args, runs);
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

/** The run's chats whose agent is waiting on a question, with the questions (answer with graft_answer). */
async function waitingChats(client: GraftClient, chats: (string | undefined)[]): Promise<Json[]> {
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

async function converseTool(client: GraftClient, name: string, args: Json): Promise<unknown> {
  const chatId = String(args.chatId);
  if (name === "graft_send")
    return send(client, chatId, String(args.message), { steer: args.steer === true });
  if (name === "graft_answer")
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
  client: GraftClient,
  name: string,
  args: Json,
  defaultSession?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (name === "graft_chats")
    return (await client.command("chat.list", { limit: Number(args.limit ?? 20) })).chats;
  if (name === "graft_search") return searchTool(client, args);
  if (name === "graft_context")
    return toolValue(client, "context", {}, "context", defaultSession, signal);
  return toolValue(client, "routine", args, "routine", defaultSession, signal);
}

async function toolValue(
  client: GraftClient,
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

async function inspectTool(client: GraftClient, name: string, args: Json): Promise<unknown> {
  // Fail fast: anything else is not a tool, and must not wait on a chat lookup.
  if (name !== "graft_trace" && name !== "graft_result") throw new Error("Unknown tool " + name);
  const result = await inspect(client, String(args.chatId));
  if (name === "graft_trace") return result.trace;
  if (name === "graft_result") return withoutTrace(result);
  throw new Error("Unknown tool " + name);
}

export function startRun(
  client: GraftClient,
  args: Json,
  runs: Map<string, Run>,
): { runId: string } {
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
  const ms = Number(process.env.GRAFT_CATALOG_POLL_MS ?? 5000);
  const interval = Number.isFinite(ms) && ms >= 50 ? ms : 5000;
  const timer = setInterval(() => void refreshCatalog(true).catch(() => undefined), interval);
  timer.unref();
  return () => clearInterval(timer);
}

const CATALOG_READY_MS = 10_000;
let catalogPriming: Promise<unknown> | undefined;

/** Waits (bounded) for the first catalog load, so a call right after initialize finds its tool. */
async function catalogReady(): Promise<void> {
  if (catalogState.primed) return;
  catalogPriming ??= refreshCatalog(false).finally(() => (catalogPriming = undefined));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    catalogPriming.catch(() => undefined),
    new Promise((resolve) => (timer = setTimeout(resolve, CATALOG_READY_MS))),
  ]);
  clearTimeout(timer);
}

async function refreshCatalog(notify: boolean): Promise<CatalogTool[]> {
  const next = await loadCatalog();
  const fingerprint = catalogFingerprint(next);
  // The code surface is fixed: a new mapped site is found through graft_find, not a new tool.
  if (
    surface === "full" &&
    notify &&
    catalogState.primed &&
    fingerprint !== catalogState.fingerprint
  )
    notifySend({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  catalogState = { tools: next, fingerprint, primed: true };
  return next;
}

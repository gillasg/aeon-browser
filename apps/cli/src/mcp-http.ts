import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MCP_SESSION_META } from "@aeon/protocol";
import { allowedHost } from "@browserkit/tools/site-to-api";
import { requestToken, verifyToken } from "./mcp-tokens.js";

// Streamable HTTP for `aeon mcp --http`: POST /mcp takes one JSON-RPC message and answers it as
// JSON; GET /mcp opens the event stream that carries notifications, task status and our own
// sampling requests. 127.0.0.1 only, with the loopback Host/Origin guard against DNS rebinding,
// and every request needs a per-client token from `aeon mcp token create`.

type Json = Record<string, unknown>;
type Send = (message: Json) => void;

export interface HttpMcpOptions {
  port?: number;
  /** Test seam: the token check (default: the saved per-client tokens). */
  verify?: (token: string) => Promise<string | undefined>;
  /** Called with each client message and the function that answers it. */
  receive: (message: Json, send: Send, client: string) => Promise<void>;
  /** Writes audit lines (default stderr). */
  audit?: (line: string) => void;
}

export interface HttpMcpServer {
  url: string;
  /** Pushes a notification or request to the event streams it belongs to: a subscription's
   * events go only to the session that subscribed; everything else goes to every stream. */
  broadcast: Send;
  close(): Promise<void>;
}

const MAX_BODY = 5_000_000;

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Json = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(headers as Record<string, string>),
  });
  response.end(body === undefined ? "" : JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("Body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function serveMcpHttp(options: HttpMcpOptions): Promise<HttpMcpServer> {
  const verify = options.verify ?? ((token: string) => verifyToken(token));
  const audit = options.audit ?? ((line: string) => process.stderr.write(`${line}\n`));
  const { streams, owners, broadcast } = sessionRouter();
  // Which token identity created each session: another token never attaches to it.
  const sessionClients = sessionBindings(() => streams);

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!allowedHost(request)) return sendJson(response, 403, { error: "Forbidden" });
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path !== "/mcp") return sendJson(response, 404, { error: "Not found" });
    const client = await verify(requestToken(request.headers));
    if (!client)
      return sendJson(
        response,
        401,
        { error: "Missing or revoked token" },
        { "www-authenticate": "Bearer" },
      );
    const session = String(request.headers["mcp-session-id"] ?? "") || randomUUID();
    if (!sessionClients.claim(session, client))
      return sendJson(response, 403, { error: "This session belongs to another token" });
    if (request.method === "GET") return openStream(response, session);
    if (request.method === "DELETE") return closeSession(response, session, owners, sessionClients);
    if (request.method !== "POST") return sendJson(response, 405, { error: "Method not allowed" });
    return handlePost(request, response, session, client);
  }

  async function handlePost(
    request: IncomingMessage,
    response: ServerResponse,
    session: string,
    client: string,
  ): Promise<void> {
    let message: Json;
    try {
      message = (await readJson(request)) as Json;
    } catch {
      return sendJson(response, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }
    if (message.method) audit(`mcp ${client} ${String(message.method)}${toolName(message)}`);
    if (refusedUnsubscribe(message, session, owners, response)) return;
    let answered = false;
    const send: Send = (reply) => {
      if (answered) return broadcast(reply);
      answered = true;
      const subscription = (reply.result as Json | undefined)?.subscriptionId;
      if (message.method === "events/subscribe" && typeof subscription === "string")
        owners.set(subscription, session);
      sendJson(response, 200, reply, { "mcp-session-id": session });
    };
    await options.receive(withSession(message, session), send, client);
    // A notification or a reply to our own request has no answer of its own.
    if (!answered && (message.id === undefined || !message.method)) {
      answered = true;
      sendJson(response, 202, undefined, { "mcp-session-id": session });
    }
  }

  function openStream(response: ServerResponse, session: string): void {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "mcp-session-id": session,
    });
    response.write(": open\n\n");
    const set = streams.get(session) ?? new Set<ServerResponse>();
    streams.set(session, set);
    set.add(response);
    response.on("close", () => {
      set.delete(response);
      if (!set.size) streams.delete(session);
    });
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent)
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4790, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    broadcast,
    close: () =>
      new Promise((resolve) => {
        sessionClients.stop();
        for (const set of streams.values()) for (const stream of set) stream.end();
        server.close(() => resolve());
      }),
  };
}

/** The HTTP session id becomes the REPL session, unless the caller named one in _meta. */
function withSession(message: Json, session: string): Json {
  const params = message.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return message;
  const meta = ((params as Json)._meta as Json | undefined) ?? {};
  return {
    ...message,
    params: {
      ...(params as Json),
      _meta: { [MCP_SESSION_META]: `http-${session.slice(0, 12)}`, ...meta },
    },
  };
}

function closeSession(
  response: ServerResponse,
  session: string,
  owners: Map<string, string>,
  bindings: SessionBindings,
): void {
  for (const [id, owner] of owners) if (owner === session) owners.delete(id);
  bindings.delete(session);
  sendJson(response, 204, undefined);
}

/** Only the session that subscribed may end a subscription: another's gets unsubscribed:false. */
function refusedUnsubscribe(
  message: Json,
  session: string,
  owners: Map<string, string>,
  response: ServerResponse,
): boolean {
  if (message.method !== "events/unsubscribe") return false;
  const id = String((message.params as Json | undefined)?.subscriptionId ?? "");
  if (owners.get(id) === session) {
    owners.delete(id);
    return false;
  }
  if (message.id === undefined) sendJson(response, 202, undefined);
  else
    sendJson(
      response,
      200,
      { jsonrpc: "2.0", id: message.id, result: { unsubscribed: false } },
      { "mcp-session-id": session },
    );
  return true;
}

export interface SessionBindings {
  /** True when `client` may use `session` (binding it on first use). */
  claim(session: string, client: string): boolean;
  delete(session: string): boolean;
  size(): number;
  sweep(): void;
  stop(): void;
}

/** A session unused this long, with no open stream, is forgotten. */
export const SESSION_IDLE_MS = 30 * 60_000;

/** Session id to the token identity that created it. Entries end on DELETE or when idle, so the
 * map cannot grow without bound (every request without a session id makes a new one). */
export function sessionBindings(
  streams: () => Map<string, Set<ServerResponse>>,
  idleMs = SESSION_IDLE_MS,
): SessionBindings {
  const bound = new Map<string, { client: string; seen: number }>();
  const sweep = () => {
    const now = Date.now();
    for (const [session, entry] of bound)
      if (now - entry.seen >= idleMs && !streams().has(session)) bound.delete(session);
  };
  const timer = setInterval(sweep, Math.min(idleMs, 60_000));
  timer.unref?.();
  return {
    claim(session: string, client: string): boolean {
      const entry = bound.get(session);
      if (entry && entry.client !== client) return false;
      bound.set(session, { client, seen: Date.now() });
      return true;
    },
    delete: (session: string) => bound.delete(session),
    size: () => bound.size,
    sweep,
    stop: () => clearInterval(timer),
  };
}

/** Open event streams per session, and which session owns each event subscription. */
function sessionRouter() {
  const streams = new Map<string, Set<ServerResponse>>();
  // Which session subscribed to an event stream (aeon/tap included): its frames go there only.
  const owners = new Map<string, string>();
  const write = (stream: ServerResponse, message: Json) =>
    stream.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  const broadcast: Send = (message) => {
    const subscription = subscriptionOf(message);
    if (subscription !== undefined) {
      const owner = owners.get(subscription);
      // Fail closed: a subscription's events never reach a session that did not open it.
      for (const stream of owner ? (streams.get(owner) ?? []) : []) write(stream, message);
      return;
    }
    for (const set of streams.values()) for (const stream of set) write(stream, message);
  };
  return { streams, owners, broadcast };
}

/** The subscription a pushed event belongs to, if it is one. */
function subscriptionOf(message: Json): string | undefined {
  if (message.method !== "notifications/events/emitted") return undefined;
  const id = (message.params as Json | undefined)?.subscriptionId;
  return id === undefined ? "" : String(id);
}

function toolName(message: Json): string {
  const name = (message.params as Json | undefined)?.name;
  return message.method === "tools/call" && typeof name === "string" ? ` ${name}` : "";
}

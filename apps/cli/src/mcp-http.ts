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
  /** Pushes a notification or request to every open event stream. */
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
  const streams = new Set<ServerResponse>();
  const broadcast: Send = (message) => {
    for (const stream of streams)
      stream.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  };

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
    if (request.method === "GET") return openStream(response, session);
    if (request.method === "DELETE") return sendJson(response, 204, undefined);
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
    let answered = false;
    const send: Send = (reply) => {
      if (answered) return broadcast(reply);
      answered = true;
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
    streams.add(response);
    response.on("close", () => streams.delete(response));
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
        for (const stream of streams) stream.end();
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

function toolName(message: Json): string {
  const name = (message.params as Json | undefined)?.name;
  return message.method === "tools/call" && typeof name === "string" ? ` ${name}` : "";
}

// A live third-screen viewer on 127.0.0.1: site.pipe runs and aeon/tap streams push rows and
// frames, any number of browser tabs watch them arrive over Server-Sent Events. Only loopback
// listens, and only a holder of the random token may push.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { liveViewHtml } from "./live-view-html.js";

export interface LiveViewOptions {
  title?: string;
  port?: number;
  maxRows?: number;
  maxEvents?: number;
}

export interface LiveViewState {
  title: string;
  updatedAt: number | null;
  rows: unknown[];
  frames: unknown[];
}

export interface LiveView {
  url: string;
  eventsUrl: string;
  pushUrl: string;
  token: string;
  pushRows(rows: unknown[], meta?: { title?: string | undefined }): void;
  pushFrame(frame: unknown): void;
  snapshot(): LiveViewState;
  close(): Promise<void>;
}

const MAX_BODY = 8 * 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Pages on loopback and extension pages (where site.pipe runs) may push; other web origins may not. */
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (origin.startsWith("chrome-extension://")) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname);
  } catch {
    return false;
  }
}

function tokenOf(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  const own = req.headers["x-aeon-view-token"];
  return typeof own === "string" ? own : "";
}

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": `${type}; charset=utf-8`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

const sseChunk = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export async function startLiveView(options: LiveViewOptions = {}): Promise<LiveView> {
  const maxRows = options.maxRows ?? 5000;
  const maxEvents = options.maxEvents ?? 500;
  const token = randomBytes(24).toString("base64url");
  const state: LiveViewState = {
    title: options.title ?? "Aeon live",
    updatedAt: null,
    rows: [],
    frames: [],
  };
  const clients = new Set<ServerResponse>();
  const broadcast = (event: string, data: unknown): void => {
    const chunk = sseChunk(event, data);
    for (const client of clients) client.write(chunk);
  };
  const view = {
    pushRows(rows: unknown[], meta: { title?: string | undefined } = {}): void {
      state.rows = (Array.isArray(rows) ? rows : [rows]).slice(-maxRows);
      if (meta.title) state.title = meta.title;
      state.updatedAt = Date.now();
      broadcast("rows", { title: state.title, rows: state.rows, updatedAt: state.updatedAt });
    },
    pushFrame(frame: unknown): void {
      state.frames.push(frame);
      if (state.frames.length > maxEvents) state.frames.splice(0, state.frames.length - maxEvents);
      state.updatedAt = Date.now();
      broadcast("frame", { frame, updatedAt: state.updatedAt });
    },
    snapshot: (): LiveViewState => structuredClone(state),
  };
  const server = createServer((req, res) => {
    void route(req, res, { view, clients, token, maxEvents, state });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    url: `${base}/`,
    eventsUrl: `${base}/events`,
    pushUrl: `${base}/push`,
    token,
    ...view,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of clients) client.end();
        clients.clear();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

interface Route {
  view: Pick<LiveView, "pushRows" | "pushFrame" | "snapshot">;
  clients: Set<ServerResponse>;
  token: string;
  maxEvents: number;
  state: LiveViewState;
}

function openEvents(req: IncomingMessage, res: ServerResponse, ctx: Route): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.write(sseChunk("snapshot", ctx.view.snapshot()));
  ctx.clients.add(res);
  req.on("close", () => ctx.clients.delete(res));
}

async function push(req: IncomingMessage, res: ServerResponse, ctx: Route): Promise<void> {
  if (!originAllowed(req.headers.origin)) return send(res, 403, { error: "origin not allowed" });
  if (!sameToken(tokenOf(req), ctx.token)) return send(res, 401, { error: "token required" });
  let body: Record<string, unknown>;
  try {
    body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
  } catch {
    return send(res, 400, { error: "send JSON: {rows} or {frame}" });
  }
  const title = typeof body.title === "string" ? body.title : undefined;
  if (Array.isArray(body.rows)) ctx.view.pushRows(body.rows, { title });
  else if (body.frame !== undefined) ctx.view.pushFrame(body.frame);
  else return send(res, 400, { error: "send JSON: {rows} or {frame}" });
  send(res, 200, { ok: true });
}

async function route(req: IncomingMessage, res: ServerResponse, ctx: Route): Promise<void> {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (req.method === "GET" && path === "/")
    return send(res, 200, liveViewHtml(ctx.state.title, ctx.maxEvents), "text/html");
  if (req.method === "GET" && path === "/events") return openEvents(req, res, ctx);
  if (req.method === "GET" && path === "/state") return send(res, 200, ctx.view.snapshot());
  if (req.method === "POST" && path === "/push") return push(req, res, ctx);
  send(res, 404, { error: "not found" });
}

/** Feeds aeon/tap frames into a viewer. `subscribe` returns its own unsubscribe. */
export function pipeTapToLiveView(
  view: Pick<LiveView, "pushFrame">,
  subscribe: (onFrame: (frame: unknown) => void) => (() => void) | { unsubscribe(): void },
): () => void {
  let active = true;
  const handle = subscribe((frame) => {
    if (active) view.pushFrame(frame);
  });
  return () => {
    active = false;
    if (typeof handle === "function") handle();
    else handle.unsubscribe();
  };
}

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { handleApi } from "./api.js";
import { HttpError, sameToken, sendJson } from "./http.js";
import { LoginError, LoginService, type ModelAccountOptions } from "./service.js";

// The API behind Aeon's Models page, on 127.0.0.1: providers, sign-ins, API keys and the default
// model. The extension page talks to it with the token in the address core hands it, and opens
// providers' sign-in pages as Chrome tabs itself.

export interface LoginServer {
  /** The service's address, with its access token in the fragment (`#token=`). */
  readonly url: string;
  readonly origin: string;
  readonly port: number;
  /** Required by every API call, as the `x-aeon-login-token` header or `?token=`. */
  readonly token: string;
  readonly service: LoginService;
  /** "closed" once no page has followed the service for a few seconds. */
  readonly events: EventEmitter;
  close(): Promise<void>;
}

const CLOSE_GRACE_MS = 4_000;

export async function startLoginServer(options: ModelAccountOptions = {}): Promise<LoginServer> {
  const service = new LoginService(options);
  const token = randomBytes(24).toString("base64url");
  const events = new EventEmitter();
  const presence = presenceTracker(() => events.emit("closed"));
  const context = { service, presence: presence.change, done: () => events.emit("done") };
  let origin = "";
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void route(request, response).catch((error: unknown) => fail(response, error));
  });
  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", origin);
    checkHost(request, origin);
    if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found");
    const crossOrigin = checkOrigin(request, response);
    if (request.method === "OPTIONS" && crossOrigin) return void response.writeHead(204).end();
    const given = request.headers["x-aeon-login-token"] ?? url.searchParams.get("token");
    if (!sameToken(typeof given === "string" ? given : undefined, token))
      throw new HttpError(401, "Missing or wrong token");
    await handleApi(context, request, response, url.pathname);
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  return {
    url: `${origin}/#token=${token}`,
    origin,
    port,
    token,
    service,
    events,
    close: async () => {
      service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Only this machine, by name: blocks other sites reaching the server through DNS rebinding. */
function checkHost(request: IncomingMessage, origin: string): void {
  const port = new URL(origin).port;
  const host = request.headers.host ?? "";
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
    throw new HttpError(403, "Unexpected host");
}

/** Extension pages get CORS headers; other web pages are refused. */
function checkOrigin(request: IncomingMessage, response: ServerResponse): boolean {
  const from = request.headers.origin;
  if (!from) return false;
  if (!from.startsWith("chrome-extension://")) throw new HttpError(403, "Origin not allowed");
  response.setHeader("access-control-allow-origin", from);
  response.setHeader("access-control-allow-headers", "content-type, x-aeon-login-token");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("vary", "origin");
  return true;
}

function fail(response: ServerResponse, error: unknown): void {
  if (response.headersSent) return void response.end();
  if (error instanceof HttpError) return sendJson(response, error.status, { error: error.message });
  if (error instanceof LoginError) return sendJson(response, 400, { error: error.message });
  sendJson(response, 500, { error: error instanceof Error ? error.message : "Unexpected error" });
}

/** Fires `onClosed` once every following page has gone and none came back within a few seconds. */
function presenceTracker(onClosed: () => void): { change: (delta: 1 | -1) => void } {
  let open = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    change(delta) {
      open += delta;
      if (timer) clearTimeout(timer);
      timer = open > 0 ? undefined : setTimeout(onClosed, CLOSE_GRACE_MS);
    },
  };
}

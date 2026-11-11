import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import {
  CoreChatStopReplySchema,
  CoreChatStopRequestSchema,
  CoreHelloSchema,
  CoreOpenChatRequestSchema,
  CoreSettingsRequestSchema,
  CoreToolRequestSchema,
  SUPPORTED_PROTOCOL_VERSION,
} from "@aeon/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { ChatService } from "./chat-service.js";
import type { BrowserControlService } from "./browser-control-service.js";
import type { ThreadCoordinationService } from "./thread-coordination-service.js";
import { attachDevChatCommands } from "./dev-chat-connection.js";
import { watchSocketHealth } from "./socket-health.js";
import { relayAgentSettings } from "./agent-settings.js";
import { handleBlockedSites } from "./core-blocked-sites.js";
import { handleBrowsers, handleChatPin, pin } from "./core-browsers.js";
import { sessionChatId } from "@aeon/pi-adapter";
import { handleBrowserRun } from "./core-browser.js";
import { handleCdpRequest } from "./core-cdp.js";
import { handleModelComplete } from "./core-model.js";
import { handleCoreHealth, handleCorePing } from "./core-health.js";
import type { CoreAttention } from "./core-attention.js";
import { attachAttentionSocket, handleAttentionMessage } from "./core-attention-socket.js";

export async function startCoreTransport(
  directory: string,
  service: ChatService,
  browser: BrowserControlService,
  threads: ThreadCoordinationService,
  attention: CoreAttention,
): Promise<{ close(): Promise<void> }> {
  const token = randomBytes(32).toString("base64url");
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    path: "/core/v1",
    maxPayload: 4 * 1024 * 1024,
    perMessageDeflate: false,
    verifyClient: (info, callback) =>
      callback(!info.req.headers.origin, 403, "NATIVE_CLIENT_REQUIRED"),
  });
  server.on("connection", (socket) =>
    authenticate(socket, token, service, browser, threads, attention, directory),
  );
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Core endpoint unavailable");
  const path = join(directory, "core-connection.json");
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(
      path + ".tmp",
      JSON.stringify({
        protocolVersion: SUPPORTED_PROTOCOL_VERSION,
        endpoint: `ws://127.0.0.1:${address.port}/core/v1`,
        token,
        pid: process.pid,
      }),
      { mode: 0o600 },
    );
    await rename(path + ".tmp", path);
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    close: async () => {
      await unlink(path).catch(() => undefined);
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function authenticate(
  socket: WebSocket,
  token: string,
  service: ChatService,
  browser: BrowserControlService,
  threads: ThreadCoordinationService,
  attention: CoreAttention,
  directory: string,
): void {
  const timer = setTimeout(() => socket.close(1008, "AUTHENTICATION_TIMEOUT"), 3000);
  socket.once("close", () => clearTimeout(timer));
  const onMessage = (data: Buffer | string, binary: boolean): void => {
    let candidate: unknown;
    try {
      candidate = JSON.parse(data.toString()) as unknown;
    } catch {
      socket.off("message", onMessage);
      clearTimeout(timer);
      socket.close(1008, "INVALID_HELLO");
      return;
    }
    if (handleCorePing(socket, candidate)) return;
    socket.off("message", onMessage);
    clearTimeout(timer);
    const hello = CoreHelloSchema.safeParse(candidate);
    if (binary || !hello.success || !equalToken(token, hello.data.token))
      return socket.close(1008, "AUTHENTICATION_FAILED");
    const version = hello.data.protocolVersion;
    if (
      version.major !== SUPPORTED_PROTOCOL_VERSION.major ||
      version.minor > SUPPORTED_PROTOCOL_VERSION.minor
    )
      return socket.close(1008, "UPDATE_REQUIRED");
    watchSocketHealth(socket);
    socket.send(
      JSON.stringify({ kind: "core.ready", protocolVersion: SUPPORTED_PROTOCOL_VERSION }),
    );
    attachAttentionSocket(socket, attention);
    attachDevChatCommands(
      socket,
      service,
      () => true,
      (chatId, target, url) => browser.attachContext(chatId, target, url),
      threads,
      (candidate) => routeAuthenticated(socket, candidate, attention, service, browser, directory),
    );
  };
  socket.on("message", onMessage);
}

function routeAuthenticated(
  socket: WebSocket,
  candidate: unknown,
  attention: CoreAttention,
  service: ChatService,
  browser: BrowserControlService,
  directory: string,
): boolean {
  const routes = [
    () => handleAttentionMessage(socket, candidate, attention),
    () => handleOpenChat(socket, candidate, service, browser),
    () => handleChatStop(socket, candidate, service, browser),
    () => handleSettings(socket, candidate, browser),
    () => handleBrowserRun(socket, candidate, browser, directory),
    () => handleCdpRequest(socket, candidate, browser, directory),
    () => handleModelComplete(socket, candidate, service),
    () => handleBlockedSites(socket, candidate, browser),
    () => handleBrowsers(socket, candidate, browser, directory),
    () => handleChatPin(socket, candidate, browser, directory),
    () => handleCorePing(socket, candidate),
    () => handleCoreHealth(socket, candidate, browser),
    () =>
      handleToolRequest(socket, candidate, service, (session, name) =>
        pin(browser, directory, sessionChatId("external", session), name),
      ),
  ];
  return routes.some((route) => route());
}

function handleOpenChat(
  socket: WebSocket,
  candidate: unknown,
  service: ChatService,
  browser: BrowserControlService,
): boolean {
  const request = CoreOpenChatRequestSchema.safeParse(candidate);
  if (!request.success) return false;
  const known = Boolean(
    service.getChat(request.data.chatId as Parameters<ChatService["getChat"]>[0]),
  );
  const { chatId, active, typed } = request.data;
  if (known && typed) {
    void browser.openTypedChat(chatId, typed).then((result) =>
      socket.send(
        JSON.stringify({
          kind: "core.chat.opened",
          chatId,
          browsers: result.ok ? 1 : 0,
          typed: result.ok,
          ...(result.recording !== undefined ? { recording: result.recording } : {}),
          ...(result.error ? { error: result.error } : {}),
        }),
      ),
    );
    return true;
  }
  const browsers = known ? browser.openChatTab(chatId, active) : 0;
  socket.send(JSON.stringify({ kind: "core.chat.opened", chatId, browsers }));
  return true;
}

/** `aeon stop`: stop the chat's Pi run and tidy the tabs it left open. */
function handleChatStop(
  socket: WebSocket,
  candidate: unknown,
  service: ChatService,
  browser: BrowserControlService,
): boolean {
  const request = CoreChatStopRequestSchema.safeParse(candidate);
  if (!request.success) return false;
  const { requestId, chatId } = request.data;
  void service.stop(chatId as Parameters<ChatService["stop"]>[0]).then(
    () => {
      browser.tidyChat(chatId);
      socket.send(
        JSON.stringify(
          CoreChatStopReplySchema.parse({
            kind: "core.chat.stopped",
            requestId,
            chatId,
            stopped: true,
          }),
        ),
      );
    },
    (error: unknown) => {
      socket.send(
        JSON.stringify({
          kind: "core.chat.stopped",
          requestId,
          chatId,
          stopped: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  );
  return true;
}
/** `aeon settings`: read or change the agent settings in every connected Chrome. */
function handleSettings(
  socket: WebSocket,
  candidate: unknown,
  browser: BrowserControlService,
): boolean {
  const request = CoreSettingsRequestSchema.safeParse(candidate);
  if (!request.success) return false;
  const { requestId, set } = request.data;
  void relayAgentSettings(browser.executorSockets(), set).then((browsers) =>
    socket.send(JSON.stringify({ kind: "core.settings.result", requestId, browsers })),
  );
  return true;
}
/** The chat tools for agents outside Aeon: listed, or called in a named session. */
function handleToolRequest(
  socket: WebSocket,
  candidate: unknown,
  service: ChatService,
  pinSession: (session: string, browser: string) => Promise<void>,
): boolean {
  const request = CoreToolRequestSchema.safeParse(candidate);
  if (!request.success) return false;
  const { requestId } = request.data;
  const send = (body: Record<string, unknown>) =>
    socket.send(JSON.stringify({ kind: "core.tool.result", requestId, ...body }));
  if (request.data.kind === "core.tool.list") {
    send({ tools: service.externalTools() });
    return true;
  }
  const { tool, session, browser, arguments: input } = request.data;
  (browser ? pinSession(session, browser) : Promise.resolve())
    .then(() => service.callExternalTool(tool, session, input))
    .then(
      (result) => send(result),
      (error: unknown) =>
        send({
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        }),
    );
  return true;
}
function equalToken(expected: string, actual: string): boolean {
  const left = Buffer.from(expected),
    right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

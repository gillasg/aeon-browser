import type { CoreAttention } from "./core-attention.js";
import { watchSocketHealth } from "./socket-health.js";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  AuthHelloSchema,
  AuthReplySchema,
  NativeBootstrapRequestSchema,
  NativeBootstrapResponseSchema,
  NativeSupervisorBootstrapEnvelopeSchema,
  SUPPORTED_PROTOCOL_VERSION,
  type AuthHello,
  type AuthReply,
  type NativeBootstrapResponse,
} from "@aeon/protocol";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { ChatService } from "./chat-service.js";
import { attachDevChatCommands } from "./dev-chat-connection.js";
import { GrantAuthority } from "./grant-authority.js";
import { BrowserInventoryRegistry } from "./browser-inventory-registry.js";
import { attachNativeExecutor } from "./native-executor-messages.js";
import { authorizeNativeUiScope } from "./native-ui-authz.js";
import { BrowserControlService } from "./browser-control-service.js";
import type { ThreadCoordinationService } from "./thread-coordination-service.js";

const MAX_BOOTSTRAP_BYTES = 16 * 1024;
const MAX_SOCKET_BYTES = 4 * 1024 * 1024;

export interface NativeTransport {
  endpoint: string;
  close(): Promise<void>;
  handleBootstrapEnvelope(candidate: unknown): NativeBootstrapResponse;
  inventories: BrowserInventoryRegistry;
}

export async function startNativeTransport(
  service: ChatService,
  extensionOrigin: string,
  browserControl = new BrowserControlService(),
  threadCoordination?: ThreadCoordinationService,
  attention?: CoreAttention,
): Promise<NativeTransport> {
  const grants = new GrantAuthority(extensionOrigin);
  const inventories = new BrowserInventoryRegistry();
  browserControl.useInventories(inventories);
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    path: "/aeon/v1",
    maxPayload: MAX_SOCKET_BYTES,
    perMessageDeflate: false,
    verifyClient: (info, callback) => {
      callback(info.origin === extensionOrigin, 403, "ORIGIN_NOT_ALLOWED");
    },
  });
  server.on("connection", (socket, request) => {
    watchSocketHealth(socket);
    authenticateSocket(
      socket,
      request.headers.origin ?? "",
      service,
      extensionOrigin,
      server,
      grants,
      inventories,
      browserControl,
      threadCoordination,
      attention,
    );
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Loopback WebSocket has no TCP endpoint.");
  const endpoint = `ws://127.0.0.1:${address.port}/aeon/v1`;

  return {
    endpoint,
    inventories,
    handleBootstrapEnvelope: (candidate) =>
      handleBootstrapEnvelope(candidate, extensionOrigin, endpoint, grants),
    close: async () => {
      for (const client of server.clients) client.close(1001, "Daemon stopping");
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function handleBootstrapEnvelope(
  candidate: unknown,
  extensionOrigin: string,
  endpoint: string,
  grants: GrantAuthority,
): NativeBootstrapResponse {
  const envelope = NativeSupervisorBootstrapEnvelopeSchema.safeParse(candidate);
  if (!envelope.success) return bootstrapFailure("INVALID_REQUEST", false);
  if (envelope.data.origin !== extensionOrigin)
    return bootstrapFailure("ORIGIN_NOT_ALLOWED", false);

  let raw: unknown;
  try {
    const bytes = Buffer.from(envelope.data.requestBase64, "base64");
    if (bytes.length === 0 || bytes.length > MAX_BOOTSTRAP_BYTES) throw new Error("size");
    raw = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return bootstrapFailure("INVALID_REQUEST", false);
  }
  const request = NativeBootstrapRequestSchema.safeParse(raw);
  if (!request.success) return bootstrapFailure("INVALID_REQUEST", false);
  if (!supportedVersion(request.data.protocolVersion))
    return bootstrapFailure("UPDATE_REQUIRED", false);

  const issued = grants.issueExecutor(request.data.clientInstanceId, request.data.browserRunId);
  return NativeBootstrapResponseSchema.parse({
    kind: "native.bootstrap.result",
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    ok: true,
    endpoint,
    connectionGrant: issued.token,
    expiresAt: issued.expiresAt,
    daemonProtocolVersion: SUPPORTED_PROTOCOL_VERSION,
  });
}

function authenticateSocket(
  socket: WebSocket,
  origin: string,
  service: ChatService,
  extensionOrigin: string,
  server: WebSocketServer,
  grants: GrantAuthority,
  inventories: BrowserInventoryRegistry,
  browserControl: BrowserControlService,
  threadCoordination?: ThreadCoordinationService,
  attention?: CoreAttention,
): void {
  const timeout = globalThis.setTimeout(() => rejectSocket(socket, "MALFORMED_HELLO"), 3_000);
  const onHello = (data: RawData, binary: boolean): void => {
    globalThis.clearTimeout(timeout);
    socket.off("message", onHello);
    const hello = parseHello(data, binary);
    if (!hello) return rejectSocket(socket, "MALFORMED_HELLO");
    if (!supportedVersion(hello.protocolVersion)) return rejectSocket(socket, "UPDATE_REQUIRED");
    if (origin !== extensionOrigin) return rejectSocket(socket, "ORIGIN_NOT_ALLOWED");
    const check = grants.consume(origin, hello);
    if (!check.ok) return rejectSocket(socket, check.code);

    const ready = AuthReplySchema.parse({
      kind: "auth.ready",
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      role: hello.role,
      connectionId: randomUUID(),
    });
    socket.send(JSON.stringify(ready));
    if (check.context.role === "ui") {
      attachDevChatCommands(
        socket,
        service,
        (request) => authorizeNativeUiScope(check.context, request),
        (chatId, target, url) => browserControl.attachContext(chatId, target, url),
        threadCoordination,
      );
    } else {
      attachNativeExecutor(
        socket,
        check.context,
        service,
        endpointFromServer(server),
        grants,
        inventories,
        browserControl,
        attention,
      );
    }
  };
  socket.on("message", onHello);
  socket.once("close", () => globalThis.clearTimeout(timeout));
}

function parseHello(data: RawData, binary: boolean): AuthHello | undefined {
  if (binary) return undefined;
  try {
    const parsed = AuthHelloSchema.safeParse(JSON.parse(data.toString()) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function rejectSocket(
  socket: WebSocket,
  code: Extract<AuthReply, { kind: "auth.rejected" }>["code"],
): void {
  const reply = AuthReplySchema.parse({
    kind: "auth.rejected",
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    code,
  });
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(reply), () => socket.close(1008, code));
  else socket.close(1008, code);
}

function bootstrapFailure(
  code:
    | "INVALID_REQUEST"
    | "ORIGIN_NOT_ALLOWED"
    | "UPDATE_REQUIRED"
    | "DAEMON_OFFLINE"
    | "HOST_CONFIG_INVALID"
    | "BOOTSTRAP_UNAVAILABLE",
  retryable: boolean,
): NativeBootstrapResponse {
  return NativeBootstrapResponseSchema.parse({
    kind: "native.bootstrap.result",
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    ok: false,
    code,
    retryable,
    supportedProtocolVersion: SUPPORTED_PROTOCOL_VERSION,
  });
}

function supportedVersion(version: { major: number; minor: number }): boolean {
  return (
    version.major === SUPPORTED_PROTOCOL_VERSION.major &&
    version.minor <= SUPPORTED_PROTOCOL_VERSION.minor
  );
}

function endpointFromServer(server: WebSocketServer): string {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Loopback WebSocket endpoint disappeared.");
  return `ws://127.0.0.1:${address.port}/aeon/v1`;
}

import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { HelloRejectionSchema, SUPPORTED_PROTOCOL_VERSION } from "@aeon/protocol";
import { ChatService } from "./chat-service.js";
import { attachDevChatCommands } from "./dev-chat-connection.js";
import type { ThreadCoordinationService } from "./thread-coordination-service.js";
import { negotiateHello, rejectPrivilegedMessage } from "./handshake.js";

const DEV_HOST = "127.0.0.1";
const DEV_PORT = 43172;
const DEV_PATH = "/dev/handshake";
const MAX_FRAME_BYTES = 3 * 1024 * 1024;

interface DevHarnessOptions {
  port?: number;
  grant?: string;
  printGrant?: boolean;
  chatService?: ChatService;
  threadCoordination?: ThreadCoordinationService;
}

export interface DevHarness {
  url: string;
  grant: string;
  close(): Promise<void>;
}

function isExtensionOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.protocol === "chrome-extension:" && /^[a-p]{32}$/.test(url.hostname);
  } catch {
    return false;
  }
}

function sendRejection(socket: WebSocket, code: "MALFORMED_HELLO" | "ORIGIN_NOT_ALLOWED"): void {
  const response = HelloRejectionSchema.parse({
    kind: "hello.reject",
    stage: "handshake",
    code,
    supportedProtocolVersion: SUPPORTED_PROTOCOL_VERSION,
  });
  socket.send(JSON.stringify(response));
  socket.close(1008, code);
}

function parseJsonFrame(data: RawData, isBinary: boolean): unknown {
  if (isBinary) return undefined;
  try {
    return JSON.parse(data.toString()) as unknown;
  } catch {
    return undefined;
  }
}

function attachClient(
  socket: WebSocket,
  origin: string | undefined,
  grant: string,
  chatService?: ChatService,
  threadCoordination?: ThreadCoordinationService,
): void {
  if (!isExtensionOrigin(origin)) {
    sendRejection(socket, "ORIGIN_NOT_ALLOWED");
    return;
  }

  let accepted = false;
  const handleMessage = (data: RawData, isBinary: boolean): void => {
    if (accepted) {
      socket.send(JSON.stringify(rejectPrivilegedMessage()));
      socket.close(1008, "privileged commands disabled");
      return;
    }

    const candidate = parseJsonFrame(data, isBinary);
    const decision = negotiateHello(candidate, grant);
    socket.send(JSON.stringify(decision.response));
    if (!decision.accepted) {
      socket.close(1008, decision.response.code);
      return;
    }
    accepted = true;
    if (decision.response.kind === "hello.ack" && decision.response.role === "ui" && chatService) {
      socket.off("message", handleMessage);
      attachDevChatCommands(socket, chatService, undefined, undefined, threadCoordination);
    }
  };
  socket.on("message", handleMessage);
}

export async function startDevHandshakeServer(
  options: DevHarnessOptions = {},
): Promise<DevHarness> {
  const grant = options.grant ?? randomBytes(32).toString("base64url");
  const server = new WebSocketServer({
    host: DEV_HOST,
    port: options.port ?? DEV_PORT,
    path: DEV_PATH,
    maxPayload: MAX_FRAME_BYTES,
  });
  const sockets = new Set<WebSocket>();
  server.on("connection", (socket, request) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    attachClient(
      socket,
      request.headers.origin,
      grant,
      options.chatService,
      options.threadCoordination,
    );
  });
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("The development socket has no TCP address.");
  if (options.printGrant ?? true) {
    process.stdout.write(`Aeon development grant: ${grant}\n`);
  }

  return {
    url: `ws://${DEV_HOST}:${address.port}${DEV_PATH}`,
    grant,
    close: async () => {
      for (const socket of sockets) socket.close(1001, "Development server closing");
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

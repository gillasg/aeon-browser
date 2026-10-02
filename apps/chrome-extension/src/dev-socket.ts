import {
  HelloAckSchema,
  HelloRejectionSchema,
  HelloSchema,
  SUPPORTED_PROTOCOL_VERSION,
  type ClientRole,
  type Hello,
  type HelloAck,
  type HelloRejection,
} from "@pippin/protocol";

const DEV_SOCKET_URL = "ws://127.0.0.1:43172/dev/handshake";

export type DevConnectionResult =
  | { kind: "ack"; message: HelloAck; socket: WebSocket }
  | { kind: "rejected"; message: HelloRejection }
  | {
      kind: "local-error";
      code: "TIMEOUT" | "CONNECTION_FAILED" | "INVALID_RESPONSE" | "INVALID_GRANT";
    };

function parseResponse(data: unknown, socket: WebSocket): DevConnectionResult {
  let message: unknown;
  try {
    message = JSON.parse(String(data)) as unknown;
  } catch {
    return { kind: "local-error", code: "INVALID_RESPONSE" };
  }

  const acknowledgement = HelloAckSchema.safeParse(message);
  if (acknowledgement.success) {
    return { kind: "ack", message: acknowledgement.data, socket };
  }

  const rejection = HelloRejectionSchema.safeParse(message);
  return rejection.success
    ? { kind: "rejected", message: rejection.data }
    : { kind: "local-error", code: "INVALID_RESPONSE" };
}

function awaitHandshake(socket: WebSocket, hello: Hello): Promise<DevConnectionResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DevConnectionResult): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      if (result.kind !== "ack") socket.close();
      resolve(result);
    };
    const timeout = globalThis.setTimeout(
      () => finish({ kind: "local-error", code: "TIMEOUT" }),
      5000,
    );

    socket.addEventListener("open", () => socket.send(JSON.stringify(hello)), { once: true });
    socket.addEventListener("message", (event) => finish(parseResponse(event.data, socket)));
    socket.addEventListener(
      "error",
      () => finish({ kind: "local-error", code: "CONNECTION_FAILED" }),
      {
        once: true,
      },
    );
    socket.addEventListener(
      "close",
      () => finish({ kind: "local-error", code: "CONNECTION_FAILED" }),
      {
        once: true,
      },
    );
  });
}

export function connectDevelopmentClient(
  role: ClientRole,
  connectionGrant: string,
): Promise<DevConnectionResult> {
  const hello = HelloSchema.safeParse({
    kind: "hello",
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    role,
    connectionGrant,
  });
  if (!hello.success) return Promise.resolve({ kind: "local-error", code: "INVALID_GRANT" });

  try {
    return awaitHandshake(new WebSocket(DEV_SOCKET_URL), hello.data);
  } catch {
    return Promise.resolve({ kind: "local-error", code: "CONNECTION_FAILED" });
  }
}

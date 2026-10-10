import {
  AuthHelloSchema,
  AuthReplySchema,
  SUPPORTED_PROTOCOL_VERSION,
  type PageGrantScope,
} from "@pippin/protocol";
import {
  NativePageGrantRequestSchema,
  NativePageGrantResponseSchema,
} from "./native-extension-message.js";
import { DevUiClient, type UiConnectResult } from "./dev-ui-client.js";

export async function connectNativeUi(scope: PageGrantScope): Promise<UiConnectResult> {
  const pageInstanceId = crypto.randomUUID();
  let raw: unknown;
  try {
    raw = await chrome.runtime.sendMessage(
      NativePageGrantRequestSchema.parse({
        kind: "pippin.native.page-grant",
        pageInstanceId,
        scope,
      }),
    );
  } catch {
    return { kind: "failed", code: "DAEMON_OFFLINE" };
  }
  const response = NativePageGrantResponseSchema.safeParse(raw);
  if (!response.success) return { kind: "failed", code: "BOOTSTRAP_UNAVAILABLE" };
  if (!response.data.ok) return { kind: "failed", code: response.data.code };
  if (
    response.data.pageInstanceId !== pageInstanceId ||
    !sameScope(response.data.scope, scope) ||
    response.data.expiresAt <= Date.now()
  )
    return { kind: "failed", code: "BOOTSTRAP_UNAVAILABLE" };

  const hello = AuthHelloSchema.parse({
    kind: "auth.hello",
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    role: "ui",
    clientInstanceId: response.data.clientInstanceId,
    browserRunId: response.data.browserRunId,
    pageInstanceId,
    connectionGrant: response.data.connectionGrant,
  });
  const socket = new WebSocket(response.data.endpoint);
  const reply = await authenticate(socket, hello);
  if (!reply || reply.kind !== "auth.ready" || reply.role !== "ui")
    return {
      kind: "failed",
      code: reply?.kind === "auth.rejected" ? reply.code : "CONNECTION_TIMEOUT",
    };
  return { kind: "connected", client: new DevUiClient(socket) };
}

function authenticate(socket: WebSocket, hello: unknown) {
  return new Promise<ReturnType<typeof AuthReplySchema.parse> | undefined>((resolve) => {
    let settled = false;
    const finish = (reply?: ReturnType<typeof AuthReplySchema.parse>) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      if (!reply || reply.kind !== "auth.ready") socket.close();
      resolve(reply);
    };
    const timer = globalThis.setTimeout(() => finish(), 5000);
    const onMessage = (event: MessageEvent) => {
      let candidate: unknown;
      try {
        candidate = JSON.parse(String(event.data)) as unknown;
      } catch {
        return finish();
      }
      const parsed = AuthReplySchema.safeParse(candidate);
      if (!parsed.success) return finish();
      finish(parsed.data);
    };
    socket.addEventListener("message", onMessage, { once: true });
    socket.addEventListener("open", () => socket.send(JSON.stringify(hello)), { once: true });
    socket.addEventListener("error", () => finish(), { once: true });
    socket.addEventListener("close", () => finish(), { once: true });
  });
}

function sameScope(left: PageGrantScope, right: PageGrantScope): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== "chat" || (right.kind === "chat" && left.chatId === right.chatId))
  );
}

import {
  AuthHelloSchema,
  AuthReplySchema,
  SUPPORTED_PROTOCOL_VERSION,
  type PageGrantScope,
} from "@aeon/protocol";
import {
  NativePageGrantRequestSchema,
  NativePageGrantResponseSchema,
} from "./native-extension-message.js";
import { UiClient, type UiConnectResult } from "./ui-client-core.js";
import { withConnectionTimeout } from "./connection-timeout.js";

export async function connectNativeUi(scope: PageGrantScope): Promise<UiConnectResult> {
  const pageInstanceId = crypto.randomUUID();
  let raw: unknown;
  try {
    // A wedged worker must fail the attempt so the page can retry, not hang on "Connecting…".
    raw = await withConnectionTimeout(
      chrome.runtime.sendMessage(
        NativePageGrantRequestSchema.parse({
          kind: "aeon.native.page-grant",
          pageInstanceId,
          scope,
        }),
      ),
      8_000,
    );
  } catch (error) {
    return { kind: "failed", code: await unreachableCode(error) };
  }
  const response = NativePageGrantResponseSchema.safeParse(raw);
  if (!response.success) return { kind: "failed", code: "BOOTSTRAP_UNAVAILABLE" };
  if (!response.data.ok) return { kind: "failed", code: await workerCode(response.data.code) };
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
  return { kind: "connected", client: new UiClient(socket) };
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

/**
 * CONNECTION_TIMEOUT: the worker took the message but never answered. WORKER_UNREACHABLE: no
 * worker took it at all (it crashed at load).
 */
async function unreachableCode(error: unknown): Promise<string> {
  const timedOut = error instanceof Error && error.message === "CONNECTION_TIMEOUT";
  const health = await workerHealth();
  if (!health) return timedOut ? "CONNECTION_TIMEOUT" : "WORKER_UNREACHABLE";
  return health.startupFailures?.length
    ? "WORKER_DEGRADED"
    : timedOut
      ? "CONNECTION_TIMEOUT"
      : "DAEMON_OFFLINE";
}

/** WORKER_DEGRADED when part of the worker failed to start: that, not the daemon, is the cause. */
async function workerCode(code: string): Promise<string> {
  return (await workerHealth())?.startupFailures?.length ? "WORKER_DEGRADED" : code;
}

function workerHealth(): Promise<{ startupFailures?: string[] } | undefined> {
  return withConnectionTimeout(
    chrome.runtime.sendMessage({ kind: "aeon.native.health" }) as Promise<{
      startupFailures?: string[];
    }>,
    2_000,
  ).catch(() => undefined);
}

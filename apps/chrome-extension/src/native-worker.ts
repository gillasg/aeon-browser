import "./completion-notifications.js";
import {
  BrowserExecutorHeartbeatReplySchema,
  BrowserExecutorHeartbeatSchema,
  AuthHelloSchema,
  AuthReplySchema,
  BrowserInventoryReplySchema,
  NativeBootstrapRequestSchema,
  NativeBootstrapResponseSchema,
  PageGrantIssueRequestSchema,
  PageGrantIssueResponseSchema,
  SUPPORTED_PROTOCOL_VERSION,
  type PageGrantIssueResponse,
  type PageGrantScope,
} from "@pippin/protocol";
import {
  NativeExtensionRequestSchema,
  NativeOpenChatResponseSchema,
  NativePageGrantResponseSchema,
} from "./native-extension-message.js";
import { claimBrowserContextSubmit } from "./native-browser-context-submit.js";
import { synchronizeBrowserInventory } from "./native-inventory-client.js";
import { installNativeBrowserContextMenus } from "./native-browser-context-menu.js";
import { handleBrowserExecutorMessage, releaseBrowserExecutor } from "./native-browser-executor.js";
import {
  getBrowserIdentity,
  hostErrorCode,
  nativeErrorCode,
  sameScope,
  type BrowserIdentity,
} from "./native-worker-identity.js";
import {
  isOpenChatSender,
  isPageScopeAllowed,
  openNativeChat,
  takeNativeInitialSubmit,
} from "./native-worker-tabs.js";

const NATIVE_HOST = "com.pippin.native_host_dev";
const GRANT_WAIT_MS = 5000;
const EXECUTOR_HEARTBEAT_MS = 20_000;
interface PendingGrant {
  resolve(response: PageGrantIssueResponse | undefined): void;
  timer: number;
}
interface ExecutorConnection extends BrowserIdentity {
  endpoint: string;
  socket: WebSocket;
  pending: Map<string, PendingGrant>;
  heartbeatTimer?: number;
}

let executor: ExecutorConnection | undefined;
let connecting: Promise<ExecutorConnection> | undefined;

void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
installNativeBrowserContextMenus(() => ensureExecutor());

chrome.runtime.onInstalled.addListener(() => void ensureExecutor().catch(() => undefined));
chrome.runtime.onStartup.addListener(() => void ensureExecutor().catch(() => undefined));
chrome.runtime.onMessage.addListener((request, sender, sendResponse) =>
  handleRuntimeMessage(request, sender, sendResponse),
);

function handleRuntimeMessage(
  candidate: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean | void {
  const request = NativeExtensionRequestSchema.safeParse(candidate);
  if (!request.success || sender.id !== chrome.runtime.id) return;
  if (request.data.kind === "pippin.native.page-grant") {
    void getPageGrant(sender, request.data.pageInstanceId, request.data.scope).then(sendResponse);
    return true;
  }
  if (request.data.kind === "pippin.native.take-initial-submit") {
    void takeNativeInitialSubmit(sender, request.data.chatId).then(sendResponse);
    return true;
  }
  if (request.data.kind === "pippin.native.claim-browser-context-submit") {
    void claimBrowserContextSubmit(sender, request.data.chatId, request.data.invocationId).then(
      sendResponse,
    );
    return true;
  }
  if (!isOpenChatSender(sender)) return;
  void openNativeChat(sender, request.data)
    .then(sendResponse)
    .catch(() =>
      sendResponse(NativeOpenChatResponseSchema.parse({ ok: false, code: "TAB_OPEN_FAILED" })),
    );
  return true;
}

async function getPageGrant(
  sender: chrome.runtime.MessageSender,
  pageInstanceId: string,
  scope: PageGrantScope,
): Promise<unknown> {
  if (!isPageScopeAllowed(sender, scope))
    return NativePageGrantResponseSchema.parse({ ok: false, code: "INVALID_SENDER" });
  const connection = await ensureExecutor().catch((error: unknown) => ({
    error: nativeErrorCode(error),
  }));
  if ("error" in connection)
    return NativePageGrantResponseSchema.parse({ ok: false, code: connection.error });

  const requestId = crypto.randomUUID();
  const pending = waitForPageGrant(connection, requestId);
  connection.socket.send(
    JSON.stringify(
      PageGrantIssueRequestSchema.parse({
        kind: "grant.page.issue",
        requestId,
        pageInstanceId,
        scope,
      }),
    ),
  );
  const response = await pending;
  if (!response || !response.ok)
    return NativePageGrantResponseSchema.parse({
      ok: false,
      code: response && !response.ok ? response.code : "DAEMON_OFFLINE",
    });
  if (response.pageInstanceId !== pageInstanceId || !sameScope(response.scope, scope))
    return NativePageGrantResponseSchema.parse({ ok: false, code: "BOOTSTRAP_UNAVAILABLE" });
  return NativePageGrantResponseSchema.parse({
    ok: true,
    endpoint: response.endpoint,
    connectionGrant: response.connectionGrant,
    expiresAt: response.expiresAt,
    protocolVersion: response.protocolVersion,
    clientInstanceId: response.clientInstanceId,
    browserRunId: response.browserRunId,
    pageInstanceId: response.pageInstanceId,
    scope: response.scope,
  });
}

function waitForPageGrant(
  connection: ExecutorConnection,
  requestId: string,
): Promise<PageGrantIssueResponse | undefined> {
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(() => {
      connection.pending.delete(requestId);
      resolve(undefined);
    }, GRANT_WAIT_MS);
    connection.pending.set(requestId, { resolve, timer });
  });
}

async function ensureExecutor(): Promise<ExecutorConnection> {
  if (executor?.socket.readyState === WebSocket.OPEN) return executor;
  if (connecting) return connecting;
  connecting = connectExecutor().finally(() => {
    connecting = undefined;
  });
  return connecting;
}

async function connectExecutor(): Promise<ExecutorConnection> {
  const identity = await getBrowserIdentity();
  const native = await sendNativeBootstrap(identity);
  const hello = AuthHelloSchema.parse({
    kind: "auth.hello",
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    role: "extension-executor",
    ...identity,
    connectionGrant: native.connectionGrant,
  });
  const socket = new WebSocket(native.endpoint);
  const reply = await authenticate(socket, hello);
  if (!reply || reply.kind !== "auth.ready" || reply.role !== "extension-executor")
    throw new Error(reply?.kind === "auth.rejected" ? reply.code : "DAEMON_OFFLINE");

  const connection: ExecutorConnection = {
    ...identity,
    endpoint: native.endpoint,
    socket,
    pending: new Map(),
  };
  socket.addEventListener("message", (event) => handleExecutorMessage(connection, event.data));
  socket.addEventListener("close", () => dropExecutor(connection), { once: true });
  try {
    await synchronizeBrowserInventory(socket, identity);
  } catch (error) {
    socket.close(4001, "Inventory sync failed");
    throw error;
  }
  executor = connection;
  connection.heartbeatTimer = globalThis.setInterval(() => {
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    try {
      connection.socket.send(
        JSON.stringify(
          BrowserExecutorHeartbeatSchema.parse({
            kind: "browser.executor.heartbeat",
            clientInstanceId: connection.clientInstanceId,
            browserRunId: connection.browserRunId,
          }),
        ),
      );
    } catch {
      connection.socket.close(4004, "Executor heartbeat failed");
    }
  }, EXECUTOR_HEARTBEAT_MS);
  return connection;
}

async function sendNativeBootstrap(identity: BrowserIdentity) {
  const request = NativeBootstrapRequestSchema.parse({
    kind: "native.bootstrap",
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    ...identity,
  });
  const result = await new Promise<{ response?: unknown; error?: string }>((resolve) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, request, (response) => {
      resolve({
        response,
        ...(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : {}),
      });
    });
  });
  if (result.error) throw new Error(hostErrorCode(result.error));
  const parsed = NativeBootstrapResponseSchema.safeParse(result.response);
  if (!parsed.success) throw new Error("BOOTSTRAP_UNAVAILABLE");
  if (!parsed.data.ok) throw new Error(parsed.data.code);
  if (parsed.data.expiresAt <= Date.now()) throw new Error("DAEMON_OFFLINE");
  return parsed.data;
}

function authenticate(
  socket: WebSocket,
  hello: unknown,
): Promise<ReturnType<typeof AuthReplySchema.parse> | undefined> {
  return new Promise((resolve) => {
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
      let value: unknown;
      try {
        value = JSON.parse(String(event.data)) as unknown;
      } catch {
        return finish();
      }
      const parsed = AuthReplySchema.safeParse(value);
      if (!parsed.success) return finish();
      finish(parsed.data);
    };
    socket.addEventListener("message", onMessage, { once: true });
    socket.addEventListener("open", () => socket.send(JSON.stringify(hello)), { once: true });
    socket.addEventListener("error", () => finish(), { once: true });
    socket.addEventListener("close", () => finish(), { once: true });
  });
}

function handleExecutorMessage(connection: ExecutorConnection, data: unknown): void {
  let candidate: unknown;
  try {
    candidate = JSON.parse(String(data)) as unknown;
  } catch {
    connection.socket.close(4002, "Invalid daemon response");
    return;
  }
  const heartbeat = BrowserExecutorHeartbeatReplySchema.safeParse(candidate);
  if (heartbeat.success) {
    if (
      heartbeat.data.clientInstanceId !== connection.clientInstanceId ||
      heartbeat.data.browserRunId !== connection.browserRunId
    )
      connection.socket.close(4003, "Invalid heartbeat acknowledgement");
    return;
  }
  if (BrowserInventoryReplySchema.safeParse(candidate).success) return;
  if (handleBrowserExecutorMessage(connection, connection.socket, candidate)) return;
  const response = PageGrantIssueResponseSchema.safeParse(candidate);
  if (!response.success) {
    connection.socket.close(4003, "Unsupported daemon response");
    return;
  }
  const pending = connection.pending.get(response.data.requestId);
  if (!pending) return;
  connection.pending.delete(response.data.requestId);
  globalThis.clearTimeout(pending.timer);
  pending.resolve(response.data);
}

function dropExecutor(connection: ExecutorConnection): void {
  if (executor === connection) releaseBrowserExecutor();
  if (connection.heartbeatTimer !== undefined) globalThis.clearInterval(connection.heartbeatTimer);
  if (executor === connection) executor = undefined;
  for (const [requestId, pending] of connection.pending) {
    globalThis.clearTimeout(pending.timer);
    pending.resolve(undefined);
    connection.pending.delete(requestId);
  }
}

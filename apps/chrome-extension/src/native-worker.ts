import { authenticate } from "@browser-use-extension/engine/native-authenticate";
import { configureEngine } from "@browser-use-extension/engine/engine-config";
import { migrateLegacyChromeStorage } from "@browser-use-extension/engine/legacy-storage-migration";
import {
  installNativeStartup,
  scheduleExecutorReconnect,
  startExecutorHeartbeat,
} from "@browser-use-extension/engine/native-executor-lifecycle";
import { handleContextPicker } from "./context-picker-handler.js";
import {
  captureCurrentPage,
  claimBrowserContextSubmit,
  installNativeBrowserContextMenus,
} from "./native-browser-context-menu.js";
import {
  installCoreAttentionBridge,
  handleCoreAttentionMessage,
} from "./completion-notifications.js";
import { installBrowserPopupGuard } from "@browser-use-extension/engine/native-browser-popup";
import {
  BrowserExecutorHeartbeatReplySchema,
  AuthHelloSchema,
  BrowserInventoryReplySchema,
  NativeBootstrapRequestSchema,
  NativeBootstrapResponseSchema,
  PageGrantIssueRequestSchema,
  PageGrantIssueResponseSchema,
  SUPPORTED_PROTOCOL_VERSION,
  type PageGrantIssueResponse,
  type PageGrantScope,
} from "@aeon/protocol";
import {
  NativeExtensionRequestSchema,
  NativeOpenChatResponseSchema,
  NativePageGrantResponseSchema,
} from "./native-extension-message.js";
import { synchronizeBrowserInventory } from "@browser-use-extension/engine/native-inventory-client";
import {
  handleBrowserExecutorMessage,
  releaseBrowserExecutor,
} from "@browser-use-extension/engine/native-browser-executor";
import {
  handleBrowserCodeMessage,
  resetRealm,
} from "@browser-use-extension/engine/code-runtime-host";
import {
  getBrowserIdentity,
  hostErrorCode,
  nativeErrorCode,
  sameScope,
  type BrowserIdentity,
} from "@browser-use-extension/engine/native-worker-identity";
import {
  isOpenChatSender,
  isPageScopeAllowed,
  openNativeChat,
  takeNativeInitialSubmit,
} from "./native-worker-tabs.js";

const NATIVE_HOST = "com.aeon.native_host";
const GRANT_WAIT_MS = 5000;
interface PendingGrant {
  resolve(response: PageGrantIssueResponse | undefined): void;
  timer: number;
}
interface ExecutorConnection extends BrowserIdentity {
  endpoint: string;
  socket: WebSocket;
  pending: Map<string, PendingGrant>;
  heartbeatTimer?: number;
  inventoryReady?: Promise<void>;
}

let executor: ExecutorConnection | undefined;
let connecting: Promise<ExecutorConnection> | undefined;

configureEngine({
  controllingTitle: (chatId) => "Aeon is controlling this tab · " + chatId,
  idleTitle: "Open Aeon Chat",
  notificationIcon: "completion-icon.png",
});
void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
void migrateLegacyChromeStorage();
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
installNativeBrowserContextMenus(() => ensureInventoryExecutor());

installNativeStartup(ensureExecutor, () => scheduleExecutorReconnect(ensureExecutor));
chrome.runtime.onMessage.addListener((request, sender, sendResponse) =>
  handleRuntimeMessage(request, sender, sendResponse),
);

function handleRuntimeMessage(
  candidate: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean | void {
  if (handleContextPicker(candidate, sender, sendResponse, () => ensureInventoryExecutor()))
    return true;
  const request = NativeExtensionRequestSchema.safeParse(candidate);
  if (!request.success || sender.id !== chrome.runtime.id) return;
  if (request.data.kind === "aeon.native.current-page") {
    if (!sender.url?.startsWith(chrome.runtime.getURL(""))) return;
    void captureCurrentPage(() => ensureInventoryExecutor()).then(sendResponse, () =>
      sendResponse(null),
    );
    return true;
  }
  if (request.data.kind === "aeon.native.page-grant") {
    void getPageGrant(sender, request.data.pageInstanceId, request.data.scope).then(
      sendResponse,
      () =>
        sendResponse(NativePageGrantResponseSchema.parse({ ok: false, code: "DAEMON_OFFLINE" })),
    );
    return true;
  }
  if (request.data.kind === "aeon.native.take-initial-submit") {
    void takeNativeInitialSubmit(sender, request.data.chatId).then(sendResponse);
    return true;
  }
  if (request.data.kind === "aeon.native.claim-browser-context-submit") {
    void claimBrowserContextSubmit(sender, request.data.chatId, request.data.invocationId).then(
      sendResponse,
    );
    return true;
  }
  if (request.data.kind !== "aeon.native.open-chat" || !isOpenChatSender(sender)) return;
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
      code: response && !response.ok ? response.code : "CONNECTION_TIMEOUT",
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

async function ensureInventoryExecutor(): Promise<ExecutorConnection> {
  const connection = await ensureExecutor();
  await connection.inventoryReady;
  return connection;
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
    throw new Error(reply?.kind === "auth.rejected" ? reply.code : "CONNECTION_TIMEOUT");

  const connection: ExecutorConnection = {
    ...identity,
    endpoint: native.endpoint,
    socket,
    pending: new Map(),
  };
  socket.addEventListener("message", (event) => handleExecutorMessage(connection, event.data));
  socket.addEventListener("close", () => dropExecutor(connection), { once: true });
  executor = connection;
  installCoreAttentionBridge((request) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(request));
  });
  connection.heartbeatTimer = startExecutorHeartbeat(socket, identity);
  connection.inventoryReady = synchronizeBrowserInventory(socket, identity).then(() =>
    installBrowserPopupGuard(socket),
  );
  void connection.inventoryReady.catch(() => socket.close(4001, "Inventory sync failed"));
  return connection;
}

async function sendNativeBootstrap(identity: BrowserIdentity) {
  const request = NativeBootstrapRequestSchema.parse({
    kind: "native.bootstrap",
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    ...identity,
  });
  // A host that never answers (slow start, daemon restarting) must not hold the single-flight
  // connection forever; timing out hands it back to the normal reconnect schedule.
  const result = await new Promise<{ response?: unknown; error?: string }>((resolve) => {
    const timer = globalThis.setTimeout(() => resolve({ error: "BOOTSTRAP_TIMEOUT" }), 10_000);
    chrome.runtime.sendNativeMessage(NATIVE_HOST, request, (response) => {
      globalThis.clearTimeout(timer);
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

function handleExecutorMessage(connection: ExecutorConnection, data: unknown): void {
  let candidate: unknown;
  try {
    candidate = JSON.parse(String(data)) as unknown;
  } catch {
    connection.socket.close(4002, "Invalid daemon response");
    return;
  }
  if (handleCoreAttentionMessage(candidate)) return;
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
  if (handleBrowserCodeMessage(connection, connection.socket, candidate)) return;
  resetReleasedRealm(candidate);
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
  if (executor === connection) {
    executor = undefined;
    scheduleExecutorReconnect(ensureExecutor);
  }
  for (const [requestId, pending] of connection.pending) {
    globalThis.clearTimeout(pending.timer);
    pending.resolve(undefined);
    connection.pending.delete(requestId);
  }
}

function resetReleasedRealm(candidate: unknown): void {
  const release = candidate as { kind?: unknown; chatId?: unknown; reset?: unknown } | null;
  if (
    release?.kind === "browser.release" &&
    release.reset === true &&
    typeof release.chatId === "string"
  )
    void resetRealm(release.chatId);
}

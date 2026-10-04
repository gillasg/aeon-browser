import { asChatId } from "@pippin/domain";
import {
  BrowserExecutorHeartbeatReplySchema,
  BrowserExecutorHeartbeatSchema,
  BrowserInventoryDeltaMessageSchema,
  BrowserInventoryFullSchema,
  BrowserInventoryReplySchema,
  PageGrantIssueRequestSchema,
  PageGrantIssueResponseSchema,
  SUPPORTED_PROTOCOL_VERSION,
  type PageGrantIssueRequest,
} from "@pippin/protocol";
import { WebSocket, type RawData } from "ws";
import { BrowserInventoryRegistry } from "./browser-inventory-registry.js";
import { ChatService } from "./chat-service.js";
import { GrantAuthority, type GrantContext } from "./grant-authority.js";
import { BrowserControlService } from "./browser-control-service.js";

export function attachNativeExecutor(
  socket: WebSocket,
  executor: GrantContext,
  service: ChatService,
  endpoint: string,
  grants: GrantAuthority,
  inventories: BrowserInventoryRegistry,
  browserControl: BrowserControlService,
): void {
  const state = { inventoryReady: false };
  socket.on("message", (data: RawData, binary: boolean) => {
    const candidate = parseJson(data, binary);
    if (candidate === undefined) return socket.close(1008, "Invalid executor message");
    if (handleExecutorHeartbeat(candidate, socket, executor)) return;
    if (handleInventory(socket, candidate, executor, inventories, state, browserControl)) return;
    if (browserControl.handleExecutorResult(candidate, socket)) return;
    // Page grants authenticate the UI independently of browser inventory.
    const request = PageGrantIssueRequestSchema.safeParse(candidate);
    if (!request.success) return socket.close(1008, "Unsupported executor message");
    void issuePageGrant(socket, request.data, executor, service, endpoint, grants);
  });
}

function handleExecutorHeartbeat(
  candidate: unknown,
  socket: WebSocket,
  executor: GrantContext,
): boolean {
  const heartbeat = BrowserExecutorHeartbeatSchema.safeParse(candidate);
  if (!heartbeat.success) return false;
  if (
    heartbeat.data.clientInstanceId !== executor.clientInstanceId ||
    heartbeat.data.browserRunId !== executor.browserRunId
  ) {
    socket.close(1008, "Invalid executor heartbeat identity");
    return true;
  }
  socket.send(
    JSON.stringify(
      BrowserExecutorHeartbeatReplySchema.parse({
        kind: "browser.executor.heartbeat.ack",
        clientInstanceId: executor.clientInstanceId,
        browserRunId: executor.browserRunId,
      }),
    ),
  );
  return true;
}

function handleInventory(
  socket: WebSocket,
  candidate: unknown,
  executor: GrantContext,
  inventories: BrowserInventoryRegistry,
  state: { inventoryReady: boolean },
  browserControl: BrowserControlService,
): boolean {
  const full = BrowserInventoryFullSchema.safeParse(candidate);
  if (full.success)
    return applyFullInventory(socket, full.data, executor, inventories, state, browserControl);
  const delta = BrowserInventoryDeltaMessageSchema.safeParse(candidate);
  if (!delta.success) return false;
  return applyInventoryDelta(socket, delta.data, executor, inventories, state);
}

function applyFullInventory(
  socket: WebSocket,
  inventory: ReturnType<typeof BrowserInventoryFullSchema.parse>,
  executor: GrantContext,
  inventories: BrowserInventoryRegistry,
  state: { inventoryReady: boolean },
  browserControl: BrowserControlService,
): true {
  const accepted =
    inventory.clientInstanceId === executor.clientInstanceId &&
    inventory.browserRunId === executor.browserRunId &&
    inventories.applyFull(inventory);
  if (!accepted) socket.close(1008, "Invalid or stale browser inventory");
  else {
    state.inventoryReady = true;
    browserControl.connectExecutor(
      executor.clientInstanceId,
      socket,
      inventory.capabilities?.includes("site-scripts"),
      inventory.capabilities?.includes("browser-actions-v2"),
    );
    socket.send(
      JSON.stringify(
        BrowserInventoryReplySchema.parse({
          kind: "browser.inventory.applied",
          generation: inventory.generation,
          lastSequence: 0,
        }),
      ),
    );
  }
  return true;
}

function applyInventoryDelta(
  socket: WebSocket,
  delta: ReturnType<typeof BrowserInventoryDeltaMessageSchema.parse>,
  executor: GrantContext,
  inventories: BrowserInventoryRegistry,
  state: { inventoryReady: boolean },
): true {
  if (
    !state.inventoryReady ||
    delta.clientInstanceId !== executor.clientInstanceId ||
    delta.browserRunId !== executor.browserRunId
  ) {
    socket.close(1008, "Invalid browser inventory identity");
    return true;
  }
  const result = inventories.applyDelta(delta);
  if (!result) socket.close(1008, "Invalid browser inventory delta");
  else
    socket.send(
      JSON.stringify(
        BrowserInventoryReplySchema.parse(
          result.applied
            ? {
                kind: "browser.inventory.applied",
                generation: delta.generation,
                lastSequence: delta.sequence,
              }
            : {
                kind: "browser.inventory.resync",
                generation: delta.generation,
                expectedSequence: result.expectedSequence,
              },
        ),
      ),
    );
  return true;
}

function issuePageGrant(
  socket: WebSocket,
  request: PageGrantIssueRequest,
  executor: GrantContext,
  service: ChatService,
  endpoint: string,
  grants: GrantAuthority,
): void {
  if (request.scope.kind === "chat" && !service.getChat(asChatId(request.scope.chatId)))
    return sendGrantFailure(socket, request.requestId, "INVALID_SCOPE");
  const issued = grants.issuePage(executor, request.pageInstanceId, request.scope);
  if (!issued) return sendGrantFailure(socket, request.requestId, "DAEMON_OFFLINE");
  const response = PageGrantIssueResponseSchema.parse({
    kind: "grant.page.result",
    requestId: request.requestId,
    ok: true,
    pageInstanceId: request.pageInstanceId,
    scope: request.scope,
    connectionGrant: issued.token,
    expiresAt: issued.expiresAt,
    endpoint,
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    clientInstanceId: executor.clientInstanceId,
    browserRunId: executor.browserRunId,
  });
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
}

function sendGrantFailure(
  socket: WebSocket,
  requestId: string,
  code: "INVALID_SCOPE" | "DAEMON_OFFLINE",
): void {
  const response = PageGrantIssueResponseSchema.parse({
    kind: "grant.page.result",
    requestId,
    ok: false,
    code,
  });
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
}

function parseJson(data: RawData, binary: boolean): unknown {
  if (binary) return undefined;
  try {
    return JSON.parse(data.toString()) as unknown;
  } catch {
    return undefined;
  }
}

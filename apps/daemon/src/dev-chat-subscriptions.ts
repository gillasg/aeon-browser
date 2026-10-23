import { asChatId, PiSessionUnavailableError, type ChatId } from "@aeon/domain";
import {
  ChatCloseViewRequestSchema,
  ChatEventMessageSchema,
  ChatResumedMessageSchema,
  ChatSnapshotMessageSchema,
  ChatSubscriptionFailedMessageSchema,
  ChatViewClosedMessageSchema,
  type DaemonUiRequest,
} from "@aeon/protocol";
import { WebSocket } from "ws";
import { ChatService } from "./chat-service.js";
import { type PublishedChatEvent } from "./chat-event-hub.js";
import { sendDevChatMessage } from "./dev-chat-send.js";

export interface LiveView {
  chatId: ChatId;
  unsubscribe(): void;
}

const MAX_VIEWS_PER_SOCKET = 16;
type SubscribeRequest = Extract<DaemonUiRequest, { kind: "chat.subscribe" }>;

export async function handleChatSubscribe(
  socket: WebSocket,
  service: ChatService,
  request: SubscribeRequest,
  views: Map<string, LiveView>,
): Promise<void> {
  const chatId = asChatId(request.chatId);
  if (!hasViewCapacity(socket, request, views)) return;
  const buffer = new BufferedEvents(socket, request.chatId);
  const afterCursor = request.afterCursor;
  if (
    afterCursor &&
    (await resumeFromCursor(socket, service, request, chatId, afterCursor, views, buffer))
  )
    return;
  await sendSnapshot(socket, service, request, chatId, views, buffer);
}

async function resumeFromCursor(
  socket: WebSocket,
  service: ChatService,
  request: SubscribeRequest,
  chatId: ChatId,
  afterCursor: NonNullable<SubscribeRequest["afterCursor"]>,
  views: Map<string, LiveView>,
  buffer: BufferedEvents,
): Promise<boolean> {
  const result = service.subscribeFrom(chatId, afterCursor, buffer.publish);
  if (result.kind !== "replay") return false;
  views.set(result.subscriptionId, { chatId, unsubscribe: result.unsubscribe });
  sendDevChatMessage(
    socket,
    ChatResumedMessageSchema.parse({
      kind: "chat.resumed",
      requestId: request.requestId,
      subscriptionId: result.subscriptionId,
      cursor: result.cursor,
    }),
  );
  buffer.prepare(result.subscriptionId, afterCursor.revision);
  for (const event of result.events) buffer.send(event);
  buffer.flush();
  return true;
}

async function sendSnapshot(
  socket: WebSocket,
  service: ChatService,
  request: SubscribeRequest,
  chatId: ChatId,
  views: Map<string, LiveView>,
  buffer: BufferedEvents,
): Promise<void> {
  let view = await service.getChatView(chatId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = service.subscribeFrom(chatId, view.cursor, buffer.publish);
    if (result.kind === "snapshot-required") {
      view = await service.getChatView(chatId);
      continue;
    }
    views.set(result.subscriptionId, { chatId, unsubscribe: result.unsubscribe });
    sendDevChatMessage(
      socket,
      ChatSnapshotMessageSchema.parse({
        kind: "chat.snapshot",
        requestId: request.requestId,
        subscriptionId: result.subscriptionId,
        cursor: view.cursor,
        snapshot: view.snapshot,
      }),
    );
    buffer.prepare(result.subscriptionId, view.cursor.revision);
    for (const event of result.events) buffer.send(event);
    buffer.flush();
    return;
  }
  sendSubscriptionFailure(
    socket,
    request.requestId,
    request.chatId,
    "INVALID_COMMAND",
    "Pi events advanced during each snapshot; subscribe again for a fresh snapshot.",
  );
}

function hasViewCapacity(
  socket: WebSocket,
  request: SubscribeRequest,
  views: Map<string, LiveView>,
): boolean {
  if (views.size < MAX_VIEWS_PER_SOCKET) return true;
  sendSubscriptionFailure(
    socket,
    request.requestId,
    request.chatId,
    "INVALID_COMMAND",
    "Too many open Chat views on this socket.",
  );
  return false;
}

export function handleChatCloseView(
  socket: WebSocket,
  request: Extract<DaemonUiRequest, { kind: "chat.close-view" }>,
  views: Map<string, LiveView>,
): void {
  const parsed = ChatCloseViewRequestSchema.parse(request);
  const view = views.get(parsed.subscriptionId);
  if (view && view.chatId !== parsed.chatId) {
    socket.close(1008, "Chat view subscription scope mismatch");
    return;
  }
  view?.unsubscribe();
  views.delete(parsed.subscriptionId);
  sendDevChatMessage(
    socket,
    ChatViewClosedMessageSchema.parse({
      kind: "chat.view-closed",
      requestId: parsed.requestId,
      chatId: parsed.chatId,
      subscriptionId: parsed.subscriptionId,
    }),
  );
}

export function sendSubscriptionError(
  socket: WebSocket,
  requestId: string,
  chatId: string,
  error: unknown,
): void {
  const message = errorMessage(error);
  const code =
    error instanceof PiSessionUnavailableError
      ? "PI_UNAVAILABLE"
      : message.includes("does not exist")
        ? "CHAT_NOT_FOUND"
        : "INVALID_COMMAND";
  sendSubscriptionFailure(socket, requestId, chatId, code, message);
}

function sendSubscriptionFailure(
  socket: WebSocket,
  requestId: string,
  chatId: string,
  code: "CHAT_NOT_FOUND" | "PI_UNAVAILABLE" | "INVALID_COMMAND",
  message: string,
): void {
  sendDevChatMessage(
    socket,
    ChatSubscriptionFailedMessageSchema.parse({
      kind: "chat.subscription-failed",
      requestId,
      chatId,
      code,
      message: message.slice(0, 300),
    }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 300)
    : "The daemon could not complete this request.";
}

class BufferedEvents {
  private readonly buffered: PublishedChatEvent[] = [];
  private ready = false;
  private subscriptionId = "";
  private lastSentRevision = 0;

  constructor(
    private readonly socket: WebSocket,
    private readonly chatId: string,
  ) {}

  readonly publish = (event: PublishedChatEvent): void => {
    if (!this.ready) this.buffered.push(event);
    else this.send(event);
  };

  prepare(subscriptionId: string, lastSentRevision: number): void {
    this.subscriptionId = subscriptionId;
    this.lastSentRevision = lastSentRevision;
  }

  send(event: PublishedChatEvent): void {
    if (event.cursor.revision <= this.lastSentRevision) return;
    sendDevChatMessage(
      this.socket,
      ChatEventMessageSchema.parse({
        kind: "chat.event",
        subscriptionId: this.subscriptionId,
        chatId: this.chatId,
        event,
      }),
    );
    this.lastSentRevision = event.cursor.revision;
  }

  flush(): void {
    this.ready = true;
    for (const event of this.buffered.splice(0)) this.send(event);
  }
}

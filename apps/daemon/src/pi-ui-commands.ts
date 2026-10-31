import { asChatId } from "@aeon/domain";
import {
  ChatSummarySchema,
  ChatViewSnapshotSchema,
  PiAttachmentSchema,
  PiUiSnapshotSchema,
  type DaemonUiResponse,
} from "@aeon/protocol";
import type { WebSocket } from "ws";
import type { ChatService } from "./chat-service.js";
import type { ThreadCoordinationService } from "./thread-coordination-service.js";
import type { CommandRequest, SessionCommand } from "./dev-chat-command-types.js";
import { sendDevChatMessage } from "./dev-chat-send.js";
import { toChatSummary } from "./chat-projection.js";

export async function sendPiUiSnapshot(
  socket: WebSocket,
  service: ChatService,
  request: Extract<CommandRequest, { operation: "chat.pi-ui" }>,
): Promise<void> {
  const chatId = asChatId(request.payload.chatId);
  const chat = service.getChat(chatId);
  if (!chat) throw new Error(`Chat ${chatId} does not exist.`);
  const piUi =
    chat.status === "draft"
      ? { tree: [], slashCommands: [], extensionDialogs: [], notices: [] }
      : await service.withOpenSession(chatId, (session) => {
          const extensionUi = session.extensionUiSnapshot();
          return {
            tree: session.tree(),
            slashCommands: session.slashCommands(),
            extensionDialogs: extensionUi.dialogs,
            notices: extensionUi.notices,
          };
        });
  sendComplete(socket, request, { kind: "chat.pi-ui", piUi: PiUiSnapshotSchema.parse(piUi) });
}

export async function executePiUiAction(
  socket: WebSocket,
  service: ChatService,
  request: Extract<
    SessionCommand,
    {
      operation: "chat.navigate-tree" | "chat.edit-message" | "chat.fork-message" | "chat.compact";
    }
  >,
  threadCoordination?: ThreadCoordinationService,
): Promise<void> {
  const chatId = asChatId(request.payload.chatId);
  if (request.operation === "chat.edit-message") {
    await editMessage(socket, service, request);
    return;
  }
  if (request.operation === "chat.navigate-tree") {
    const navigation = await service.withSession(chatId, (session) =>
      session.navigateTree(request.payload.entryId),
    );
    const view = await service.refreshViews(chatId);
    sendComplete(socket, request, {
      kind: "chat.tree-navigated",
      entryId: navigation.entryId,
      cancelled: navigation.cancelled,
      editorText: navigation.cancelled ? null : navigation.editorText,
      snapshot: ChatViewSnapshotSchema.parse(view.snapshot),
      cursor: view.cursor,
    });
    return;
  }
  if (request.operation === "chat.fork-message") {
    if (!threadCoordination) throw new Error("Pi-native fork coordination is unavailable.");
    const fork = await threadCoordination.forkMessage({
      sourceChatId: chatId,
      entryId: request.payload.entryId,
      ...(request.payload.title ? { title: request.payload.title } : {}),
      idempotencyKey: request.requestId,
    });
    sendComplete(socket, request, {
      kind: "chat.message-forked",
      sourceChatId: request.payload.chatId,
      entryId: request.payload.entryId,
      status: fork.status,
      targetChatId: fork.targetChatId,
      chat: fork.chat ? ChatSummarySchema.parse(toChatSummary(fork.chat)) : null,
      reason: fork.reason,
    });
    return;
  }
  const view = await compact(service, chatId, request.payload.customInstructions);
  sendComplete(socket, request, {
    kind: "chat.view",
    snapshot: ChatViewSnapshotSchema.parse(view.snapshot),
    cursor: view.cursor,
  });
}

export async function executeExtensionUiAnswer(
  socket: WebSocket,
  service: ChatService,
  request: Extract<SessionCommand, { operation: "chat.extension-ui-answer" }>,
): Promise<void> {
  const accepted = await service.withOpenSession(asChatId(request.payload.chatId), (session) =>
    session.answerExtensionUi(request.payload.dialogRequestId, request.payload.value),
  );
  sendComplete(socket, request, {
    kind: "chat.extension-ui-answered",
    chatId: request.payload.chatId,
    accepted,
  });
}

async function compact(
  service: ChatService,
  chatId: ReturnType<typeof asChatId>,
  instructions?: string,
): Promise<Awaited<ReturnType<ChatService["getChatView"]>>> {
  await service.withSession(chatId, (session) => session.compact(instructions));
  return service.refreshViews(chatId);
}

function sendComplete(
  socket: WebSocket,
  request:
    | Extract<CommandRequest, { operation: "chat.pi-ui" }>
    | Extract<
        SessionCommand,
        {
          operation:
            | "chat.navigate-tree"
            | "chat.edit-message"
            | "chat.fork-message"
            | "chat.compact"
            | "chat.extension-ui-answer";
        }
      >,
  result: Extract<DaemonUiResponse, { kind: "command.completed" }>["result"],
): void {
  sendDevChatMessage(socket, {
    kind: "command.completed",
    requestId: request.requestId,
    operation: request.operation,
    result,
  });
}

async function editMessage(
  socket: WebSocket,
  service: ChatService,
  request: Extract<SessionCommand, { operation: "chat.edit-message" }>,
): Promise<void> {
  const chatId = asChatId(request.payload.chatId);
  const edited = await service.withSession(chatId, (session) =>
    session.editMessage(request.payload.entryId),
  );
  const view = await service.refreshViews(chatId);
  sendComplete(socket, request, {
    kind: "chat.message-edited",
    chatId: request.payload.chatId,
    entryId: edited.entryId,
    status: edited.status,
    editorText: edited.status === "ready" ? edited.editorText : null,
    attachments:
      edited.status === "ready"
        ? edited.attachments.map((attachment) => PiAttachmentSchema.parse(attachment))
        : [],
    notice: edited.status === "ready" ? edited.notice : null,
    reason: edited.status === "unsupported" ? edited.reason : null,
    snapshot: ChatViewSnapshotSchema.parse(view.snapshot),
    cursor: view.cursor,
  });
}

import { sendCommandFailure, commandErrorCode } from "./chat-command-error.js";
import { sendProjectCommand, isProjectCommand } from "./project-commands.js";
import { sendWorkspaceFile } from "./workspace-file-command.js";
import { completeCommand } from "./chat-command-complete.js";
import { asChatId } from "@pippin/domain";
import { sendChatImage } from "./chat-image-command.js";
import { ChatCatalogItemSchema, ChatSummarySchema, ChatViewSnapshotSchema } from "@pippin/protocol";
import type { BrowserTargetKey } from "@pippin/protocol";
import { ChatService } from "./chat-service.js";
import type { ThreadCoordinationService } from "./thread-coordination-service.js";
import { beginSubmit } from "./dev-chat-submit.js";
import { createAndSubmitChat } from "./chat-first-submit.js";
import {
  type BrowserContextAttachStatus,
  type CommandRequest,
  type ContextCommand,
  type NonSubmitCommand,
  type SessionCommand,
  type SimpleCommand,
  isContextCommand,
  isSessionCommand,
  isSimpleCommand,
} from "./dev-chat-command-types.js";
import {
  executeManagementAction,
  sendHomeManagementSnapshot,
  sendManagementSnapshot,
} from "./management-commands.js";
import { executeExtensionUiAnswer, executePiUiAction, sendPiUiSnapshot } from "./pi-ui-commands.js";
import { sendControls, sendEffectiveResources } from "./dev-chat-read-commands.js";
import { type WebSocket } from "ws";
export async function handleDevChatCommand(
  socket: WebSocket,
  service: ChatService,
  request: CommandRequest,
  attachBrowserContext?: (
    chatId: string,
    target: BrowserTargetKey,
    url: string,
  ) => BrowserContextAttachStatus,
  threadCoordination?: ThreadCoordinationService,
): Promise<void> {
  try {
    if (request.operation === "chat.create" && request.payload.initialSubmit)
      return await createAndSubmitChat(socket, service, request, attachBrowserContext);
    if (request.operation === "chat.delete") {
      await service.deleteChat(asChatId(request.payload.chatId));
      return completeCommand(socket, request, {
        kind: "chat.deleted",
        chatId: request.payload.chatId,
      });
    }
    if (isProjectCommand(request)) return await sendProjectCommand(socket, service, request);
    if (request.operation === "workspace.file")
      return await sendWorkspaceFile(socket, service, request);
    if (request.operation === "chat.image") return await sendChatImage(socket, service, request);
    if (request.operation === "chat.submit") beginSubmit(socket, service, request);
    else if (request.operation === "management.action")
      await executeManagementAction(socket, service, request);
    else
      await handleReadOrControlCommand(
        socket,
        service,
        request,
        attachBrowserContext,
        threadCoordination,
      );
  } catch (error) {
    sendCommandFailure(socket, request, error, commandErrorCode(error, request.operation));
  }
}
async function handleReadOrControlCommand(
  socket: WebSocket,
  service: ChatService,
  request: NonSubmitCommand,
  attachBrowserContext?: (
    chatId: string,
    target: BrowserTargetKey,
    url: string,
  ) => BrowserContextAttachStatus,
  threadCoordination?: ThreadCoordinationService,
): Promise<void> {
  if (isSimpleCommand(request)) return handleSimpleCommand(socket, service, request);
  if (isSessionCommand(request))
    return handleSessionCommand(socket, service, request, threadCoordination);
  if (isContextCommand(request))
    return handleContextCommand(socket, service, request, attachBrowserContext);
}
async function handleSimpleCommand(
  socket: WebSocket,
  service: ChatService,
  request: SimpleCommand,
): Promise<void> {
  switch (request.operation) {
    case "chat.model-catalog": {
      const catalog = await service.getModelCatalog();
      completeCommand(socket, request, {
        kind: "chat.model-catalog",
        catalog: {
          defaultModel: catalog.defaultModel ? { ...catalog.defaultModel } : null,
          models: catalog.models.map((model) => ({
            ...model,
            thinkingLevels: [...model.thinkingLevels],
          })),
        },
      });
      return;
    }
    case "chat.create":
      await sendCreated(socket, service, request);
      return;
    case "chat.list":
      await sendListed(socket, service, request);
      return;
    case "chat.update":
      sendUpdated(socket, service, request);
      return;
    case "chat.get":
      await sendView(socket, service, request);
      return;
    case "chat.resources":
      await sendEffectiveResources(socket, service, request);
      return;
    case "chat.pi-ui":
      await sendPiUiSnapshot(socket, service, request);
      return;
    case "management.get":
      await sendManagementSnapshot(socket, service, request);
      return;
    case "management.home":
      await sendHomeManagementSnapshot(socket, service, request);
      return;
    case "chat.controls":
      await sendControls(socket, service, request);
      return;
  }
}
async function handleSessionCommand(
  socket: WebSocket,
  service: ChatService,
  request: SessionCommand,
  threadCoordination?: ThreadCoordinationService,
): Promise<void> {
  switch (request.operation) {
    case "chat.model":
      await service.setModel(
        asChatId(request.payload.chatId),
        request.payload.provider,
        request.payload.id,
      );
      completeCommand(socket, request, { kind: "chat.model-set", chatId: request.payload.chatId });
      return;
    case "chat.thinking":
      await service.setThinkingLevel(asChatId(request.payload.chatId), request.payload.level);
      completeCommand(socket, request, {
        kind: "chat.thinking-set",
        chatId: request.payload.chatId,
      });
      return;
    case "chat.stop":
      await service.stop(asChatId(request.payload.chatId));
      completeCommand(socket, request, { kind: "chat.stopped", chatId: request.payload.chatId });
      return;
    case "chat.navigate-tree":
    case "chat.edit-message":
    case "chat.fork-message":
    case "chat.compact":
      await executePiUiAction(socket, service, request, threadCoordination);
      return;
    case "chat.extension-ui-answer":
      await executeExtensionUiAnswer(socket, service, request);
      return;
  }
}
async function handleContextCommand(
  socket: WebSocket,
  service: ChatService,
  request: ContextCommand,
  attachBrowserContext?: (
    chatId: string,
    target: BrowserTargetKey,
    url: string,
  ) => BrowserContextAttachStatus,
): Promise<void> {
  switch (request.operation) {
    case "chat.attach-browser-context":
      completeCommand(socket, request, {
        kind: "chat.browser-context-attached",
        chatId: request.payload.chatId,
        status:
          attachBrowserContext?.(
            request.payload.chatId,
            request.payload.target,
            request.payload.url,
          ) ?? "offline",
      });
      return;
    case "chat.queue-edit":
      await service.withSession(asChatId(request.payload.chatId), (session) => {
        if (!session.editQueue) throw new Error("Queue editing is unavailable in this session.");
        session.editQueue(request.payload);
      });
      completeCommand(socket, request, {
        kind: "chat.queued",
        chatId: request.payload.chatId,
        mode: request.payload.mode,
      });
      return;
    case "chat.queue":
      await service.queueInput(
        asChatId(request.payload.chatId),
        {
          text: request.payload.text,
          ...(request.payload.browserContexts
            ? { browserContexts: request.payload.browserContexts }
            : {}),
          ...(request.payload.attachments ? { attachments: request.payload.attachments } : {}),
          ...(request.payload.browserContext
            ? { browserContext: request.payload.browserContext }
            : {}),
        },
        request.payload.mode,
      );
      completeCommand(socket, request, {
        kind: "chat.queued",
        chatId: request.payload.chatId,
        mode: request.payload.mode,
      });
      return;
  }
}
async function sendCreated(
  socket: WebSocket,
  service: ChatService,
  request: CommandRequest,
): Promise<void> {
  if (request.operation !== "chat.create") return;
  const chat = await service.createDraft(request.payload.title, request.payload.projectId);
  completeCommand(socket, request, {
    kind: "chat.created",
    chat: {
      chatId: chat.chatId,
      title: chat.title,
      projectId: chat.projectId,
      pinned: chat.pinned,
      archived: chat.archived,
      status: chat.status,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    },
  });
}
async function sendListed(
  socket: WebSocket,
  service: ChatService,
  request: CommandRequest,
): Promise<void> {
  if (request.operation !== "chat.list") return;
  const query = request.payload.query?.trim() ?? "";
  const catalog = query
    ? await service.searchChats(query, request.payload.limit, request.payload.includeArchived)
    : {
        chats: service.listChats(request.payload.limit, request.payload.includeArchived),
        searchWarnings: 0,
      };
  completeCommand(socket, request, {
    kind: "chat.listed",
    chats: catalog.chats.map((chat) => ChatCatalogItemSchema.parse(chat)),
    ...(query && catalog.searchWarnings ? { searchWarnings: catalog.searchWarnings } : {}),
  });
}
function sendUpdated(socket: WebSocket, service: ChatService, request: CommandRequest): void {
  if (request.operation !== "chat.update") return;
  const { chatId, title, pinned, archived } = request.payload;
  const patch = {
    ...(title !== undefined ? { title } : {}),
    ...(pinned !== undefined ? { pinned } : {}),
    ...(archived !== undefined ? { archived } : {}),
  };
  const chat = service.updateMetadata(asChatId(chatId), patch);
  completeCommand(socket, request, {
    kind: "chat.updated",
    chat: ChatSummarySchema.parse(chat),
  });
}

async function sendView(
  socket: WebSocket,
  service: ChatService,
  request: CommandRequest,
): Promise<void> {
  if (request.operation !== "chat.get") return;
  const view = await service.getChatView(asChatId(request.payload.chatId));
  completeCommand(socket, request, {
    kind: "chat.view",
    snapshot: ChatViewSnapshotSchema.parse(view.snapshot),
    cursor: view.cursor,
  });
}

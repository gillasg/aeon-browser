import { sendCommandFailure, commandErrorCode } from "./chat-command-error.js";
import { sendProjectCommand, isProjectCommand } from "./project-commands.js";
import { sendWorkspaceFile } from "./workspace-file-command.js";
import { completeCommand } from "./chat-command-complete.js";
import { asChatId } from "@aeon/domain";
import { sendChatImage } from "./chat-image-command.js";
import { ChatCatalogItemSchema, ChatSummarySchema, ChatViewSnapshotSchema } from "@aeon/protocol";
import type { BrowserTargetKey } from "@aeon/protocol";
import { ChatService } from "./chat-service.js";
import type { ThreadCoordinationService } from "./thread-coordination-service.js";
import { beginSubmit } from "./dev-chat-submit.js";
import { createAndSubmitChat } from "./chat-first-submit.js";
import { applyBlockedSites } from "./blocked-sites-settings.js";
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

async function answerOutsideContext(
  socket: WebSocket,
  service: ChatService,
  request: Extract<CommandRequest, { operation: "settings.outside-context" }>,
): Promise<void> {
  const { enabled } = request.payload;
  if (enabled !== undefined) await service.setOutsideContextSetting(enabled);
  return completeCommand(socket, request, {
    kind: "settings.outside-context",
    enabled: await service.outsideContextSetting(),
  });
}

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
    if (request.operation === "settings.blocked-sites") {
      const sites = await applyBlockedSites(request.payload);
      return completeCommand(socket, request, { kind: "settings.blocked-sites", sites });
    }
    if (request.operation === "settings.outside-context")
      return await answerOutsideContext(socket, service, request);
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
/** The model catalog and the model sign-in page. */
const MODEL_COMMANDS: Partial<
  Record<
    SimpleCommand["operation"],
    (socket: WebSocket, service: ChatService, request: SimpleCommand) => Promise<void>
  >
> = {
  "chat.model-catalog": async (socket, service, request) => {
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
  },
  "chat.model-login": async (socket, service, request) => {
    completeCommand(socket, request, {
      kind: "chat.model-login",
      url: await service.openModelLogin(),
    });
  },
};

async function handleSimpleCommand(
  socket: WebSocket,
  service: ChatService,
  request: SimpleCommand,
): Promise<void> {
  const model = MODEL_COMMANDS[request.operation];
  if (model) return model(socket, service, request);
  switch (request.operation) {
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
      await service.editQueue(asChatId(request.payload.chatId), request.payload);
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
        { typedByUser: request.payload.typedByUser === true },
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
  const chat = await service.createDraft(
    request.payload.title,
    request.payload.projectId,
    request.payload.origin ?? "user",
  );
  completeCommand(socket, request, {
    kind: "chat.created",
    chat: {
      chatId: chat.chatId,
      title: chat.title,
      projectId: chat.projectId,
      origin: chat.origin,
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
  const filter = {
    ...(request.payload.origin ? { origin: request.payload.origin } : {}),
    ...(request.payload.since ? { since: request.payload.since } : {}),
    ...(request.payload.until ? { until: request.payload.until } : {}),
  };
  const catalog = query
    ? await service.searchChats(
        query,
        request.payload.limit,
        request.payload.includeArchived,
        filter,
      )
    : {
        chats: service.listChats(request.payload.limit, request.payload.includeArchived, filter),
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

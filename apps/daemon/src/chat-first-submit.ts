import { asChatId } from "@pippin/domain";
import { ChatSummarySchema, type DaemonUiRequest } from "@pippin/protocol";
import type { WebSocket } from "ws";
import type { ChatService } from "./chat-service.js";
import type { BrowserContextAttachStatus } from "./dev-chat-command-types.js";
import { completeCommand } from "./chat-command-complete.js";
import { beginSubmit } from "./dev-chat-submit.js";
import { toChatSummary } from "./chat-projection.js";

type CreateRequest = Extract<DaemonUiRequest, { operation: "chat.create" }>;

/** Start on the creator's connection; the destination page only subscribes. */
export async function createAndSubmitChat(
  socket: WebSocket,
  service: ChatService,
  request: CreateRequest,
  attach?: (
    chatId: string,
    target: import("@pippin/protocol").BrowserTargetKey,
    url: string,
  ) => BrowserContextAttachStatus,
): Promise<void> {
  const initial = request.payload.initialSubmit;
  if (!initial) throw new Error("Missing initial prompt.");
  const chat = await service.createDraft(request.payload.title, request.payload.projectId);
  try {
    for (const page of initial.browserContexts ?? []) {
      if (attach?.(chat.chatId, page.target, page.url) !== "attached")
        throw new Error("Could not attach selected tab. Remove its chip and select it again.");
    }
  } catch (error) {
    await service.deleteChat(asChatId(chat.chatId));
    throw error;
  }
  completeCommand(socket, request, {
    kind: "chat.created",
    chat: ChatSummarySchema.parse(toChatSummary(chat)),
  });
  beginSubmit(
    socket,
    service,
    {
      kind: "command",
      operation: "chat.submit",
      requestId: request.requestId,
      payload: {
        chatId: chat.chatId,
        text: initial.text,
        attachments: initial.attachments ?? [],
        browserContexts: initial.browserContexts ?? [],
      },
    },
    initial,
  );
}

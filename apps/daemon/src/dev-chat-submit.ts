import { asChatId } from "@pippin/domain";
import type { DaemonUiRequest } from "@pippin/protocol";
import { ChatService } from "./chat-service.js";
import { sendDevChatMessage } from "./dev-chat-send.js";
import { type WebSocket } from "ws";

type CommandRequest = Extract<DaemonUiRequest, { kind: "command" }>;

export function beginSubmit(
  socket: WebSocket,
  service: ChatService,
  request: CommandRequest,
): void {
  if (request.operation !== "chat.submit") return;
  const { requestId, operation, payload } = request;
  sendDevChatMessage(socket, {
    kind: "command.started",
    requestId,
    operation,
    chatId: payload.chatId,
    state: "processing",
    piAcceptance: "unknown",
  });
  void service
    .submitPrompt(asChatId(payload.chatId), {
      text: payload.text,
      ...(payload.attachments ? { attachments: payload.attachments } : {}),
      ...(payload.browserContext ? { browserContext: payload.browserContext } : {}),
    })
    .then(() => completeSubmit(socket, service, request))
    .catch((error: unknown) => failSubmit(socket, service, request, error));
}

async function completeSubmit(
  socket: WebSocket,
  service: ChatService,
  request: CommandRequest,
): Promise<void> {
  if (request.operation !== "chat.submit") return;
  const view = await service.getChatView(asChatId(request.payload.chatId));
  sendDevChatMessage(socket, {
    kind: "command.settled",
    requestId: request.requestId,
    operation: request.operation,
    chatId: request.payload.chatId,
    state: "settled",
    runState: view.snapshot.runState,
  });
}

async function failSubmit(
  socket: WebSocket,
  service: ChatService,
  request: CommandRequest,
  error: unknown,
): Promise<void> {
  if (request.operation !== "chat.submit") return;
  sendDevChatMessage(socket, {
    kind: "command.settled",
    requestId: request.requestId,
    operation: request.operation,
    chatId: request.payload.chatId,
    state: "failed",
    runState: await currentRunState(service, request.payload.chatId),
    code: "PI_PROMPT_FAILED",
    message: errorMessage(error),
    piAcceptance: "unknown",
  });
}

async function currentRunState(
  service: ChatService,
  chatId: string,
): Promise<"idle" | "running-unconfirmed" | "uncertain" | "needs_attention"> {
  try {
    return (await service.getChatView(asChatId(chatId))).snapshot.runState;
  } catch {
    return "uncertain";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 300)
    : "The daemon could not complete this request.";
}

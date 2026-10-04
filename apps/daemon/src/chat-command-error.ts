import { PiSessionUnavailableError } from "@pippin/domain";
import type { WebSocket } from "ws";
import type { CommandRequest } from "./dev-chat-command-types.js";
import { sendDevChatMessage } from "./dev-chat-send.js";
export function sendCommandFailure(
  socket: WebSocket,
  request: CommandRequest,
  error: unknown,
  code: "CHAT_NOT_FOUND" | "PI_UNAVAILABLE" | "PI_PROMPT_FAILED" | "INVALID_COMMAND",
): void {
  sendDevChatMessage(socket, {
    kind: "command.failed",
    requestId: request.requestId,
    operation: request.operation,
    code,
    message: errorMessage(error),
  });
}

export function commandErrorCode(
  error: unknown,
  operation: CommandRequest["operation"],
): "CHAT_NOT_FOUND" | "PI_UNAVAILABLE" | "PI_PROMPT_FAILED" | "INVALID_COMMAND" {
  if (error instanceof PiSessionUnavailableError) return "PI_UNAVAILABLE";
  if (errorMessage(error).includes("does not exist")) return "CHAT_NOT_FOUND";
  if (operation === "chat.submit") return "PI_PROMPT_FAILED";
  return "INVALID_COMMAND";
}
function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 300)
    : "The daemon could not complete this request.";
}

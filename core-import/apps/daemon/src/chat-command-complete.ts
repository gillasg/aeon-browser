import type { WebSocket } from "ws";
import type { DaemonUiResponse } from "@aeon/protocol";
import type { ReadCommandRequest } from "./dev-chat-command-types.js";
import { sendDevChatMessage } from "./dev-chat-send.js";
export function completeCommand(
  socket: WebSocket,
  request: ReadCommandRequest,
  result: Extract<DaemonUiResponse, { kind: "command.completed" }>["result"],
): void {
  sendDevChatMessage(socket, {
    kind: "command.completed",
    requestId: request.requestId,
    operation: request.operation,
    result,
  });
}

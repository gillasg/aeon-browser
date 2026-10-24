import { CoreModelCompleteRequestSchema, CoreModelCompleteResultSchema } from "@aeon/protocol";
import { WebSocket } from "ws";
import type { ChatService } from "./chat-service.js";
import { messageOf } from "./core-browser.js";

// The CLI's AI commands (describe, edit, name, find, map --explore) use Aeon's own model: the
// same default the next chat would use, with tool calls, so they do the work instead of asking
// the caller for a model the way a standalone command line has to.

export function handleModelComplete(
  socket: WebSocket,
  candidate: unknown,
  service: ChatService,
): boolean {
  const request = CoreModelCompleteRequestSchema.safeParse(candidate);
  if (!request.success) return false;
  const { requestId, systemPrompt, messages, tools } = request.data;
  void service.modelCompleteTools({ systemPrompt, messages, tools }).then(
    (message) =>
      send(socket, {
        kind: "core.model.result",
        requestId,
        message: JSON.parse(JSON.stringify(message)) as Record<string, unknown>,
      }),
    (error: unknown) =>
      send(socket, { kind: "core.model.result", requestId, error: messageOf(error) }),
  );
  return true;
}

function send(socket: WebSocket, body: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(CoreModelCompleteResultSchema.parse(body)));
}

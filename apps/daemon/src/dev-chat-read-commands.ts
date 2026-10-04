import { asChatId } from "@pippin/domain";
import { EffectivePiResourcesSchema, type DaemonUiResponse } from "@pippin/protocol";
import type { WebSocket } from "ws";
import type { ChatService } from "./chat-service.js";
import type { CommandRequest } from "./dev-chat-command-types.js";
import { sendDevChatMessage } from "./dev-chat-send.js";

export async function sendControls(
  socket: WebSocket,
  service: ChatService,
  request: Extract<CommandRequest, { operation: "chat.controls" }>,
): Promise<void> {
  const controls = await service.getControls(asChatId(request.payload.chatId));
  sendComplete(socket, request, {
    kind: "chat.controls",
    controls: controls
      ? {
          ...controls,
          availableModels: controls.availableModels.map((model) => ({
            ...model,
            thinkingLevels: [...model.thinkingLevels],
          })),
          availableThinkingLevels: [...controls.availableThinkingLevels],
          steeringQueue: [...controls.steeringQueue],
          followUpQueue: [...controls.followUpQueue],
        }
      : null,
  });
}

export async function sendEffectiveResources(
  socket: WebSocket,
  service: ChatService,
  request: Extract<CommandRequest, { operation: "chat.resources" }>,
): Promise<void> {
  const resources = await service.getEffectiveResources(asChatId(request.payload.chatId));
  sendComplete(socket, request, {
    kind: "chat.resources",
    resources: EffectivePiResourcesSchema.parse(resources),
  });
}

function sendComplete(
  socket: WebSocket,
  request: Extract<CommandRequest, { operation: "chat.controls" | "chat.resources" }>,
  result: Extract<DaemonUiResponse, { kind: "command.completed" }>["result"],
): void {
  sendDevChatMessage(socket, {
    kind: "command.completed",
    requestId: request.requestId,
    operation: request.operation,
    result,
  });
}

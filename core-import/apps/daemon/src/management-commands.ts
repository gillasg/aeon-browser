import { asChatId } from "@aeon/domain";
import {
  HomeManagementSnapshotSchema,
  ManagementSnapshotSchema,
  type DaemonUiResponse,
} from "@aeon/protocol";
import type { WebSocket } from "ws";
import type { ChatService } from "./chat-service.js";
import type { CommandRequest, ManagementActionCommand } from "./dev-chat-command-types.js";
import { sendDevChatMessage } from "./dev-chat-send.js";

export async function sendManagementSnapshot(
  socket: WebSocket,
  service: ChatService,
  request: Extract<CommandRequest, { operation: "management.get" }>,
): Promise<void> {
  const snapshot = await service.management.readSnapshot(
    request.payload.chatId ? asChatId(request.payload.chatId) : undefined,
  );
  sendComplete(socket, request, {
    kind: "management.snapshot",
    snapshot: ManagementSnapshotSchema.parse(snapshot),
  });
}

export async function sendHomeManagementSnapshot(
  socket: WebSocket,
  service: ChatService,
  request: Extract<CommandRequest, { operation: "management.home" }>,
): Promise<void> {
  const snapshot = HomeManagementSnapshotSchema.parse(await service.management.readHomeSnapshot());
  sendComplete(socket, request, { kind: "management.home", snapshot });
}

export async function executeManagementAction(
  socket: WebSocket,
  service: ChatService,
  request: ManagementActionCommand,
): Promise<void> {
  const chatId = asChatId(request.payload.chatId);
  await service.management.runAction(chatId, request.payload.action, request.payload.input);
  const snapshot = await service.management.readSnapshot(chatId);
  sendComplete(socket, request, {
    kind: "management.snapshot",
    snapshot: ManagementSnapshotSchema.parse(snapshot),
  });
}

function sendComplete(
  socket: WebSocket,
  request:
    | ManagementActionCommand
    | Extract<CommandRequest, { operation: "management.get" | "management.home" }>,
  result: Extract<DaemonUiResponse, { kind: "command.completed" }>["result"],
): void {
  sendDevChatMessage(socket, {
    kind: "command.completed",
    requestId: request.requestId,
    operation: request.operation,
    result,
  });
}

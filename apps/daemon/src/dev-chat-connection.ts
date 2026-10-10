import { DaemonUiRequestSchema, type BrowserTargetKey, type DaemonUiRequest } from "@aeon/protocol";
import { WebSocket, type RawData } from "ws";
import { ChatService } from "./chat-service.js";
import type { ThreadCoordinationService } from "./thread-coordination-service.js";
import { handleDevChatCommand } from "./dev-chat-commands.js";
import {
  handleChatCloseView,
  handleChatSubscribe,
  sendSubscriptionError,
  type LiveView,
} from "./dev-chat-subscriptions.js";

type BrowserContextAttachStatus = "attached" | "stale" | "lost" | "offline";

function parseRequest(data: RawData, isBinary: boolean): DaemonUiRequest | undefined {
  if (isBinary) return undefined;
  try {
    const parsed = DaemonUiRequestSchema.safeParse(JSON.parse(data.toString()) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function attachDevChatCommands(
  socket: WebSocket,
  service: ChatService,
  authorize: (request: DaemonUiRequest) => boolean = () => true,
  attachBrowserContext?: (
    chatId: string,
    target: BrowserTargetKey,
    url: string,
  ) => BrowserContextAttachStatus,
  threadCoordination?: ThreadCoordinationService,
  handleExtra?: (candidate: unknown) => boolean,
): void {
  const views = new Map<string, LiveView>();
  socket.on("message", (data: RawData, isBinary: boolean) => {
    if (!isBinary && handleExtra) {
      try {
        if (handleExtra(JSON.parse(data.toString()) as unknown)) return;
      } catch {
        socket.close(1008, "Invalid extra command");
        return;
      }
    }
    const request = parseRequest(data, isBinary);
    if (!request) {
      socket.close(1008, "Invalid closed Aeon command schema");
      return;
    }
    if (!authorize(request)) {
      socket.close(1008, "Grant scope does not authorize this request");
      return;
    }
    if (request.kind === "command") {
      void handleDevChatCommand(socket, service, request, attachBrowserContext, threadCoordination);
      return;
    }
    if (request.kind === "chat.subscribe") {
      void handleChatSubscribe(socket, service, request, views).catch((error: unknown) =>
        sendSubscriptionError(socket, request.requestId, request.chatId, error),
      );
      return;
    }
    handleChatCloseView(socket, request, views);
  });
  socket.on("close", () => {
    for (const view of views.values()) view.unsubscribe();
    views.clear();
  });
}

import { ChatIdSchema } from "@pippin/protocol";
import { InitialChatDisplay } from "./initial-chat-display.js";
import { DaemonUiRequestSchema } from "@pippin/protocol";
import type { UiClient } from "./ui-client-core.js";

interface ChatPageCloseState {
  chatId: string;
  subscriptionId: string;
  reconnectTimer: number;
  client: UiClient | undefined;
  catalogClient: UiClient | undefined;
  composer: { close(): void };
  onStorageChanged: Parameters<typeof chrome.storage.onChanged.removeListener>[0];
  markClosing(): void;
}

export function createChatPageCloser(readState: () => ChatPageCloseState): () => void {
  return () => {
    const state = readState();
    state.markClosing();
    globalThis.clearTimeout(state.reconnectTimer);
    if (state.client && state.subscriptionId && state.client.socket.readyState === WebSocket.OPEN) {
      try {
        state.client.send(
          DaemonUiRequestSchema.parse({
            kind: "chat.close-view",
            requestId: crypto.randomUUID(),
            chatId: state.chatId,
            subscriptionId: state.subscriptionId,
          }),
        );
      } catch {
        /* the socket is already closing */
      }
    }
    state.composer.close();
    chrome.storage.onChanged.removeListener(state.onStorageChanged);
    state.catalogClient?.close();
    state.client?.close();
  };
}

export function chatPageErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The local daemon could not complete this request.";
}

export function requiredChatPageElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing Chat page element: ${id}`);
  return element;
}

export function initializeChatPage(): {
  root: HTMLElement;
  chatId: string;
  initialDisplay: InitialChatDisplay;
} {
  const root = requiredChatPageElement("root");
  const parsed = ChatIdSchema.safeParse(new URL(location.href).searchParams.get("chatId"));
  const chatId = parsed.success ? parsed.data : "";
  if (new URL(location.href).searchParams.get("host") === "panel")
    document.body.dataset.host = "panel";
  return { root, chatId, initialDisplay: new InitialChatDisplay(chatId) };
}

export function reconnectChat(attempt: number, retry: () => Promise<void>): number {
  return globalThis.setTimeout(
    () => void retry(),
    Math.min(250 * 2 ** Math.min(attempt - 1, 3), 2000),
  );
}

export function initialChatConnection(): {
  label: string;
  state: "connecting" | "connected" | "error";
} {
  return { label: "Connecting", state: "connecting" };
}

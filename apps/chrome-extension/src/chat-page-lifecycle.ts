import { DaemonUiRequestSchema } from "@pippin/protocol";
import type { DevUiClient } from "./dev-ui-client.js";

interface ChatPageCloseState {
  chatId: string;
  subscriptionId: string;
  reconnectTimer: number;
  client: DevUiClient | undefined;
  catalogClient: DevUiClient | undefined;
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

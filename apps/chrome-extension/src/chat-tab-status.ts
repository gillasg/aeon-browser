import type { DaemonUiResponse, ChatViewSnapshotDto } from "@pippin/protocol";
import "./status-favicon.js";
const key = "pippin-tab-status-" + crypto.randomUUID();
let activeChatId = "";
let status: "idle" | "working" = "idle";
window.addEventListener(
  "pagehide",
  () => {
    void chrome.storage.session.remove([key, "aeon-chat-working-" + activeChatId]);
  },
  { once: true },
);
export function observeChatTabStatus(
  client: { subscribe(listener: (message: DaemonUiResponse) => void): () => void },
  chatId: string,
): void {
  activeChatId = chatId;
  const acknowledge = () => {
    if (document.visibilityState === "visible" && document.hasFocus()) {
      void chrome.storage.session.remove("piper-unread-" + chatId);
    }
  };
  window.addEventListener("focus", acknowledge);
  document.addEventListener("visibilitychange", acknowledge);
  acknowledge();
  client.subscribe((message) => {
    if (message.kind === "chat.snapshot" && message.snapshot.chat.chatId === chatId) {
      applyState(message.snapshot.runState, false);
    } else if (message.kind === "command.started" && message.chatId === chatId) publish("working");
    else if (message.kind === "command.settled" && message.chatId === chatId)
      applyState(message.runState, message.state === "settled" && status === "working");
    else if (message.kind === "chat.event" && message.chatId === chatId) {
      const event = message.event.event;
      if (event.kind === "run-state") applyState(event.state, status === "working");
      if (event.kind === "view-replaced") applyState(event.runState, false);
    }
  });
}
function applyState(state: ChatViewSnapshotDto["runState"], completed: boolean): void {
  if (state === "idle" && completed) {
    const chatId = activeChatId;
    if (chatId)
      void chrome.runtime
        .sendMessage({ kind: "piper.chat-completed", chatId })
        .catch(() => undefined);
  }
  publish(state === "running-unconfirmed" || state === "needs_attention" ? "working" : "idle");
}
function publish(next: typeof status): void {
  if (status === next) return;
  status = next;
  void chrome.storage.session.set({ [key]: next, ["aeon-chat-working-" + activeChatId]: next });
}

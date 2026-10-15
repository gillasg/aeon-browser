import type { DaemonUiResponse, ChatViewSnapshotDto } from "@aeon/protocol";
import { showStatusForChat } from "./status-favicon.js";
const key = "aeon-tab-status-" + crypto.randomUUID();
let activeChatId = "";
let status: "idle" | "working" = "idle";
window.addEventListener(
  "pagehide",
  () => {
    void chrome.storage.session.remove(key);
  },
  { once: true },
);
export function observeChatTabStatus(
  client: { subscribe(listener: (message: DaemonUiResponse) => void): () => void },
  chatId: string,
): void {
  activeChatId = chatId;
  showStatusForChat(chatId);
  const acknowledge = () => {
    const visible = document.visibilityState === "visible" && document.hasFocus();
    void chrome.storage.session
      .get("aeon-completion-id-" + chatId)
      .then((values) =>
        chrome.runtime.sendMessage({
          kind: "core.attention.read",
          chatId,
          completionId: values["aeon-completion-id-" + chatId] ?? null,
          viewId: key.slice("aeon-tab-status-".length),
          visible,
        }),
      )
      .catch(() => undefined);
  };
  window.addEventListener("focus", acknowledge);
  window.addEventListener("blur", acknowledge);
  document.addEventListener("visibilitychange", acknowledge);
  const presence = window.setInterval(acknowledge, 10000);
  window.addEventListener("pagehide", () => clearInterval(presence), { once: true });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes["aeon-completion-id-" + chatId]) acknowledge();
  });
  acknowledge();
  client.subscribe((message) => {
    if (message.kind === "chat.snapshot" && message.snapshot.chat.chatId === chatId) {
      applyState(message.snapshot.runState);
    } else if (message.kind === "command.started" && message.chatId === chatId) publish("working");
    else if (message.kind === "command.settled" && message.chatId === chatId)
      applyState(message.runState);
    else if (message.kind === "chat.event" && message.chatId === chatId) {
      const event = message.event.event;
      if (event.kind === "run-state") applyState(event.state);
      if (event.kind === "view-replaced") applyState(event.runState);
    }
  });
}
function applyState(state: ChatViewSnapshotDto["runState"]): void {
  publish(state === "running-unconfirmed" || state === "needs_attention" ? "working" : "idle");
}
function publish(next: typeof status): void {
  if (status === next) return;
  status = next;
  void chrome.storage.session.set({ [key]: next, ["aeon-chat-working-" + activeChatId]: next });
}

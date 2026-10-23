import { clearAgentCursors } from "@browserkit/engine/native-browser-cursor";
import {
  CoreAttentionAlertSchema,
  CoreAttentionClaimSchema,
  type CoreAttentionAlert,
  CoreAttentionSnapshotSchema,
  CoreAttentionRequestSchema,
  type CoreAttentionRequest,
} from "@aeon/protocol";
let send: ((request: CoreAttentionRequest) => void) | undefined;
let pending = Promise.resolve();
export function installCoreAttentionBridge(sender: (request: CoreAttentionRequest) => void): void {
  send = sender;
  sender({ kind: "core.attention.watch" });
}
export function handleCoreAttentionMessage(candidate: unknown): boolean {
  const alert = CoreAttentionAlertSchema.safeParse(candidate);
  if (alert.success) {
    void showAlert(alert.data);
    return true;
  }
  const snapshot = CoreAttentionSnapshotSchema.safeParse(candidate);
  if (snapshot.success) {
    pending = pending.then(() => mirror(snapshot.data)).catch(() => undefined);
    return true;
  }
  const claim = CoreAttentionClaimSchema.safeParse(candidate);
  if (!claim.success) return false;
  if (claim.data.granted) void notify(claim.data.chatId, claim.data.title, claim.data.summary);
  return true;
}
async function mirror(
  snapshot: ReturnType<typeof CoreAttentionSnapshotSchema.parse>,
): Promise<void> {
  const existing = await chrome.storage.session.get(null);
  const values: Record<string, string> = {};
  for (const chat of snapshot.chats) {
    // The turn is over: the agent cursor leaves its tabs.
    if (!chat.working && existing["aeon-chat-working-" + chat.chatId] === "working")
      void clearAgentCursors(chat.chatId);
    values["aeon-chat-working-" + chat.chatId] = chat.working ? "working" : "idle";
    if (chat.completionId) values["aeon-completion-id-" + chat.chatId] = chat.completionId;
    if (chat.unread && chat.completionId) {
      values["piper-unread-" + chat.chatId] = "done";
      send?.({
        kind: "core.attention.claim",
        chatId: chat.chatId,
        completionId: chat.completionId,
      });
    }
  }
  const stale = Object.keys(existing).filter(
    (key) =>
      ["aeon-chat-working-", "piper-unread-", "aeon-completion-id-"].some((prefix) =>
        key.startsWith(prefix),
      ) && !(key in values),
  );
  if (stale.length) await chrome.storage.session.remove(stale);
  await chrome.storage.session.set(values);
}
chrome.runtime.onMessage.addListener((request, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  const parsed = CoreAttentionRequestSchema.safeParse(request);
  if (parsed.success && parsed.data.kind === "core.attention.read") send?.(parsed.data);
});
// Says what happened ("Price dropped to ₹2,999"), titled with the chat, not "Your chat is ready".
async function notify(chatId: string, title?: string, summary?: string): Promise<void> {
  await chrome.notifications.create("piper-done-" + chatId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("completion-icon.png"),
    title: title || "Aeon finished",
    message: summary || "Done. Click to open the chat.",
  });
}
// A watcher found something: say what at once; the agent's follow-up run comes after.
async function showAlert(alert: CoreAttentionAlert): Promise<void> {
  await chrome.notifications.create(ALERT_PREFIX + alert.chatId + ":" + alert.alertId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("completion-icon.png"),
    title: alert.title || "Aeon watcher",
    message: alert.message || "Its check passed. Click to open the chat.",
    priority: 2,
  });
}
const ALERT_PREFIX = "aeon-alert-";
chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith("piper-done-")) void openCompletedChat(id.slice("piper-done-".length));
  if (id.startsWith(ALERT_PREFIX)) {
    const chatId = id.slice(ALERT_PREFIX.length).split(":")[0] ?? "";
    void openCompletedChat(chatId).then(() => chrome.notifications.clear(id));
  }
});
async function openCompletedChat(chatId: string): Promise<void> {
  const url = chrome.runtime.getURL("chat.html") + "?chatId=" + encodeURIComponent(chatId);
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL("chat.html") + "*" });
  const tab = tabs.find(
    (item) => item.url && new URL(item.url).searchParams.get("chatId") === chatId,
  );
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else await chrome.tabs.create({ url });
  await chrome.notifications.clear("piper-done-" + chatId);
}

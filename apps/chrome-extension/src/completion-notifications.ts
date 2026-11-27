import { clearAgentCursors } from "@browserkit/engine/native-browser-cursor";
import { presentAsk } from "./orb/orb-worker.js";
import {
  CoreAttentionAlertSchema,
  CoreAttentionClaimSchema,
  type CoreAttentionAlert,
  CoreAttentionSnapshotSchema,
  CoreAttentionRequestSchema,
  type CoreAttentionRequest,
} from "@graft/protocol";
let send: ((request: CoreAttentionRequest) => void) | undefined;
let pending = Promise.resolve();
// Each completion is claimed once. Every snapshot lists every unread chat, so re-claiming on each
// one (a presence ping every 10 s per chat page) turned old unread chats into a constant loop.
const claimed = new Set<string>();
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
    if (chat.asking) {
      values["graft-asking-" + chat.chatId] = chat.asking;
      if (existing["graft-asking-" + chat.chatId] !== chat.asking) void presentAsk(chat.chatId);
    }
    // The turn is over: the agent cursor leaves its tabs.
    if (!chat.working && existing["graft-chat-working-" + chat.chatId] === "working")
      void clearAgentCursors(chat.chatId);
    values["graft-chat-working-" + chat.chatId] = chat.working ? "working" : "idle";
    if (chat.completionId) values["graft-completion-id-" + chat.chatId] = chat.completionId;
    if (chat.unread && chat.completionId) {
      values["piper-unread-" + chat.chatId] = "done";
      claimOnce(chat.chatId, chat.completionId);
    }
  }
  const stale = Object.keys(existing).filter(
    (key) =>
      ["graft-chat-working-", "piper-unread-", "graft-completion-id-", "graft-asking-"].some(
        (prefix) => key.startsWith(prefix),
      ) && !(key in values),
  );
  if (stale.length) await chrome.storage.session.remove(stale);
  await chrome.storage.session.set(values);
}
function claimOnce(chatId: string, completionId: string): void {
  if (claimed.has(completionId)) return;
  claimed.add(completionId);
  send?.({ kind: "core.attention.claim", chatId, completionId });
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
    title: title || "Graft finished",
    message: summary || "Done. Click to open the chat.",
  });
}
// A watcher found something: say what at once; the agent's follow-up run comes after.
async function showAlert(alert: CoreAttentionAlert): Promise<void> {
  await chrome.notifications.create(ALERT_PREFIX + alert.chatId + ":" + alert.alertId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("completion-icon.png"),
    title: alert.title || "Graft watcher",
    message: alert.message || "Its check passed. Click to open the chat.",
    priority: 2,
  });
}
const ALERT_PREFIX = "graft-alert-";
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

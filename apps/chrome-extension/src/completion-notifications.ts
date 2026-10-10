import {
  CoreAttentionClaimSchema,
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
  const snapshot = CoreAttentionSnapshotSchema.safeParse(candidate);
  if (snapshot.success) {
    pending = pending.then(() => mirror(snapshot.data)).catch(() => undefined);
    return true;
  }
  const claim = CoreAttentionClaimSchema.safeParse(candidate);
  if (!claim.success) return false;
  if (claim.data.granted) void notify(claim.data.chatId);
  return true;
}
async function mirror(
  snapshot: ReturnType<typeof CoreAttentionSnapshotSchema.parse>,
): Promise<void> {
  const existing = await chrome.storage.session.get(null);
  const values: Record<string, string> = {};
  for (const chat of snapshot.chats) {
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
async function notify(chatId: string): Promise<void> {
  await chrome.notifications.create("piper-done-" + chatId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("completion-icon.png"),
    title: "Aeon finished",
    message: "Your chat is ready. Click to open it.",
  });
}
chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith("piper-done-")) void openCompletedChat(id.slice("piper-done-".length));
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

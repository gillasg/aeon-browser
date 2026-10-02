const prefix = "piper-unread-";
let pending = Promise.resolve();
chrome.runtime.onMessage.addListener((request, sender) => {
  if (
    sender.id !== chrome.runtime.id ||
    request?.kind !== "piper.chat-completed" ||
    typeof request.chatId !== "string" ||
    !/^[a-zA-Z0-9-]+$/.test(request.chatId)
  )
    return;
  pending = pending.then(() => complete(request.chatId, sender)).catch(() => undefined);
});
async function complete(chatId: string, sender: chrome.runtime.MessageSender): Promise<void> {
  const key = prefix + chatId;
  const values = await chrome.storage.session.get(key);
  if (values[key]) return;
  if (sender.tab?.id && sender.tab.active) {
    const window = await chrome.windows.get(sender.tab.windowId);
    if (window.focused) return;
  }
  await chrome.storage.session.set({ [key]: "done" });
  await chrome.notifications.create("piper-done-" + chatId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("completion-icon.png"),
    title: "Aeon finished",
    message: "Your chat is ready. Click to open it.",
  });
}
chrome.notifications.onClicked.addListener((id) => {
  if (!id.startsWith("piper-done-")) return;
  void openCompletedChat(id.slice("piper-done-".length));
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

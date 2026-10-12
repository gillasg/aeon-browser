import { NativeOpenChatSchema } from "@aeon/protocol";
import { chatUrl, findExistingChat } from "./native-worker-tabs.js";

// The Aeon CLI/MCP starts chats through Core; Core asks the extension to show each one as a tab
// so the user can watch it work. Background by default; an open tab is reused, never duplicated.
export function handleOpenChatMessage(candidate: unknown): boolean {
  const message = NativeOpenChatSchema.safeParse(candidate);
  if (!message.success) return false;
  void openChat(message.data.chatId, message.data.active).catch(() => undefined);
  return true;
}

async function openChat(chatId: string, active: boolean): Promise<void> {
  const existing = await findExistingChat(chatId);
  if (existing?.id !== undefined) {
    if (active) {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return;
  }
  const window = await chrome.windows
    .getLastFocused({ windowTypes: ["normal"] })
    .catch(() => undefined);
  await chrome.tabs.create({
    url: chatUrl(chatId),
    active,
    ...(window?.id !== undefined ? { windowId: window.id } : {}),
  });
}

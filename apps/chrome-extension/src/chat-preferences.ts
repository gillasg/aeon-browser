import type { ChatSidebarController } from "./chat-sidebar-controller.js";
import { applyStoredTheme } from "./theme-preferences.js";

export async function initializeChatPreferences(
  sidebar: ChatSidebarController,
  sidePanel: boolean,
): Promise<void> {
  await applyStoredTheme();
  const persisted = localStorage.getItem("aeon-sidebar-expanded");
  if (!sidePanel && persisted !== null) {
    sidebar.setOpen(persisted === "true");
    return;
  }
  const values = await chrome.storage.sync.get("aeon-chat-sidebar-open");
  if (!sidePanel && values["aeon-chat-sidebar-open"] === true) sidebar.setOpen(true);
}

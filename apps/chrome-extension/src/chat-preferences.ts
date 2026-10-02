import type { ChatSidebarController } from "./chat-sidebar-controller.js";
import { applyStoredTheme } from "./theme-preferences.js";

export async function initializeChatPreferences(
  sidebar: ChatSidebarController,
  sidePanel: boolean,
): Promise<void> {
  await applyStoredTheme();
  const persisted = localStorage.getItem("pippin-sidebar-expanded");
  if (!sidePanel && persisted !== null) {
    sidebar.setOpen(persisted === "true");
    return;
  }
  const values = await chrome.storage.sync.get("pippin-chat-sidebar-open");
  if (!sidePanel && values["pippin-chat-sidebar-open"] === true) sidebar.setOpen(true);
}

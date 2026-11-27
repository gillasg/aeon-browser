import type { ChatSidebarController } from "./chat-sidebar-controller.js";
import { applyStoredTheme } from "./theme-preferences.js";

export async function initializeChatPreferences(
  sidebar: ChatSidebarController,
  sidePanel: boolean,
): Promise<void> {
  await applyStoredTheme();
  const persisted = localStorage.getItem("graft-sidebar-expanded");
  if (!sidePanel && persisted !== null) {
    sidebar.setOpen(persisted === "true");
    return;
  }
  const values = await chrome.storage.sync.get("graft-chat-sidebar-open");
  if (!sidePanel && values["graft-chat-sidebar-open"] === true) sidebar.setOpen(true);
}

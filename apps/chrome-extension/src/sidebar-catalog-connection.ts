import type { ChatSidebarController } from "./chat-sidebar-controller.js";
import type { UiClient } from "./ui-client-core.js";
import { PageReconnect } from "./page-reconnect.js";
import { connectCatalogPage } from "./ui-connection.js";

export function connectSidebarCatalog(
  sidebar: ChatSidebarController,
  current: () => UiClient | undefined,
  assign: (client: UiClient) => void,
  closing: () => boolean,
  onError: (message: string) => void,
): PageReconnect {
  const reconnect = new PageReconnect(async () => {
    const client = await connectCatalogPage(current());
    if (!client) throw new Error("Could not connect to the Chat catalog.");
    if (closing()) {
      client.close();
      return;
    }
    assign(client);
    reconnect.watch(client);
    await sidebar.refresh();
  }, onError);
  window.addEventListener("focus", () => {
    if (sidebar.open && !closing()) void sidebar.refresh();
  });
  return reconnect;
}

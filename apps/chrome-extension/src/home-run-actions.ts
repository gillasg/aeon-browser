import type { HomeRunActions } from "@aeon/ui";
import type { UiClient } from "./ui-client-core.js";

// Home's running cards can show a background run's own window or stop the run. The engine keeps
// which chats work in a window of their own (spaces) and broadcasts changes.

interface Space {
  chatId: string;
  space: string;
  windowId?: number;
}

export function followHomeRunActions(options: {
  client(): UiClient | undefined;
  onChange(): void;
}): () => HomeRunActions {
  let windows = new Map<string, number>();
  const apply = (spaces: unknown) => {
    const next = new Map<string, number>();
    for (const item of Array.isArray(spaces) ? (spaces as Space[]) : [])
      if (item.space === "window" && typeof item.windowId === "number")
        next.set(item.chatId, item.windowId);
    windows = next;
    options.onChange();
  };
  chrome.runtime.onMessage.addListener((raw: unknown) => {
    const message = raw as { kind?: string; spaces?: unknown } | null;
    if (message?.kind === "browserkit.spaces") apply(message.spaces);
  });
  void chrome.runtime
    .sendMessage({ kind: "browserkit.spaces.get" })
    .then((reply: { spaces?: unknown } | undefined) => apply(reply?.spaces))
    .catch(() => undefined);
  const actions: HomeRunActions = {
    get windows() {
      return new Set(windows.keys());
    },
    onShowWindow(chatId) {
      const windowId = windows.get(chatId);
      if (windowId !== undefined) void chrome.windows.update(windowId, { focused: true });
    },
    onStop(chatId) {
      const client = options.client();
      if (!client) return;
      client.send({
        kind: "command",
        requestId: crypto.randomUUID(),
        operation: "chat.stop",
        payload: { chatId },
      });
    },
  };
  return () => actions;
}

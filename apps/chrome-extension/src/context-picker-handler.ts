import { captureTabPage } from "./native-browser-context-menu.js";
export function handleContextPicker(
  candidate: unknown,
  sender: chrome.runtime.MessageSender,
  send: (value: unknown) => void,
  ensureExecutor: () => Promise<unknown>,
): boolean {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("")))
    return false;
  if (!candidate || typeof candidate !== "object") return false;
  const value = candidate as { kind?: string; tabId?: number };
  if (value.kind === "pippin.native.list-context-tabs") {
    void Promise.all([chrome.tabs.query({}), chrome.windows.getLastFocused()]).then(
      ([tabs, window]) =>
        send(
          tabs
            .filter((tab) => tab.id !== undefined && /^https?:/.test(tab.url ?? ""))
            .map((tab) => ({
              tabId: tab.id,
              title: tab.title ?? "",
              url: tab.url,
              favIconUrl: tab.favIconUrl,
              current: tab.active && tab.windowId === window.id,
            }))
            .sort((a, b) => Number(b.current) - Number(a.current)),
        ),
      () => send([]),
    );
    return true;
  }
  if (value.kind !== "pippin.native.capture-page" || !Number.isSafeInteger(value.tabId))
    return false;
  void captureTabPage(value.tabId as number, ensureExecutor).then(send, () => send(null));
  return true;
}

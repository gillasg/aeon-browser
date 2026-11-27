// Which window a new agent tab opens in. A tab named with windowOf opens beside that tab. Otherwise
// it follows the chat's own tabs: when the user drags them to another window, the next tab opens
// there instead of jumping back. A tab or window that is gone falls back to Chrome's default.

export interface TabWindowSource {
  /** A tab's window, or undefined when the tab is gone. */
  windowOfTab(tabId: number): Promise<number | undefined>;
}

export async function resolveTabWindow(
  source: TabWindowSource,
  /** ownTabs: the chat's tabs, most recently used first. */
  options: { windowOf?: number; ownTabs: readonly number[] },
): Promise<number | undefined> {
  if (options.windowOf !== undefined) {
    const named = await source.windowOfTab(options.windowOf);
    if (named !== undefined) return named;
    throw new Error("INVALID_TARGET");
  }
  // The chat's most recently used tab that is still open decides.
  for (const tabId of options.ownTabs) {
    const windowId = await source.windowOfTab(tabId);
    if (windowId !== undefined) return windowId;
  }
  return undefined;
}

/** The live Chrome source: a tab in a normal window that still exists. */
export const chromeTabWindows: TabWindowSource = {
  async windowOfTab(tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab || tab.windowId === undefined || tab.windowId < 0) return undefined;
    const window = await chrome.windows.get(tab.windowId).catch(() => undefined);
    return window && window.type === "normal" ? tab.windowId : undefined;
  },
};

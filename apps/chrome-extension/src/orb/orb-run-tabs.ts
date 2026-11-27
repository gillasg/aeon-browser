// The cursor box's finish state for "open it for me" runs: the tabs a chat opened and kept in the
// background, listed for the box, and a one-click switch to one of them. Listing never activates
// anything, so the user's current tab stays exactly as it was until they click a pill.
import { ensureAgentTabsRestored, mineTabIds } from "@browserkit/engine/native-browser-tab-cleanup";

export interface RunTabInfo {
  tabId: number;
  title: string;
  host: string;
  favIconUrl?: string;
}

const MAX_PILLS = 6;

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Live background tabs the chat opened, most recently used first, without the asking tab. */
export async function runTabs(
  chatId: string,
  askingTabId: number | undefined,
): Promise<RunTabInfo[]> {
  await ensureAgentTabsRestored();
  const out: RunTabInfo[] = [];
  for (const tabId of mineTabIds(chatId)) {
    if (tabId === askingTabId || out.length >= MAX_PILLS) continue;
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab || tab.active || !/^https?:/.test(tab.url ?? "")) continue;
    out.push({
      tabId,
      title: tab.title ?? "",
      host: hostOf(tab.url),
      ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
    });
  }
  return out;
}

/** Switch to a tab the run opened: activate it and bring its window forward. */
export async function jumpToRunTab(tabId: number): Promise<boolean> {
  const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
  if (!tab) return false;
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  return true;
}

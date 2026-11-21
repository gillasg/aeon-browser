import type { SiteCounts } from "@aeon/ui";
import { homeSites, siteFacts } from "./site-facts.js";
import type { UiClient } from "./ui-client-core.js";

// The side panel's X-Ray line follows the active tab of its window: it is read again when another
// tab is activated or the active tab moves to another URL.

export type PanelXray = { host: string; counts: SiteCounts } | undefined;

export function watchPanelXray(
  windowId: number,
  client: () => UiClient | undefined,
  onChange: (xray: PanelXray) => void,
): void {
  let last = "";
  let seq = 0;
  const refresh = async (): Promise<void> => {
    const mine = ++seq;
    const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
    const connected = client();
    if (!tab?.url || !connected) return onChange(undefined);
    const facts = await siteFacts(tab.url, () => homeSites(connected)).catch(() => undefined);
    if (mine !== seq) return;
    const key = JSON.stringify(facts ?? null);
    if (key === last) return;
    last = key;
    onChange(facts);
  };
  chrome.tabs.onActivated.addListener((info) => {
    if (info.windowId === windowId) void refresh();
  });
  chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
    if (change.url && tab.active && tab.windowId === windowId) void refresh();
  });
  void refresh();
}

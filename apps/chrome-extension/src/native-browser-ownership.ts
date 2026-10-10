import { currentInventoryTabs } from "./native-inventory-client.js";
const key = "aeon-browser-owners";
let writes: Promise<unknown> = Promise.resolve();
export function persistBrowserOwners(owners: Map<number, string>): void {
  if (!chrome.storage?.session) return;
  const tabs = currentInventoryTabs();
  const records = [...owners].flatMap(([tabId, chatId]) => {
    const tab = tabs.find((item) => item.target.tabId === tabId);
    return tab ? [{ chatId, target: tab.target }] : [];
  });
  writes = writes
    .catch(() => undefined)
    .then(() => chrome.storage.session.set({ [key]: records }))
    .catch(() => undefined);
}
export async function restoreBrowserOwners(owners: Map<number, string>): Promise<void> {
  if (!chrome.storage?.session) return;
  const stored = (await chrome.storage.session.get(key))[key] as
    { chatId: string; target: unknown }[] | undefined;
  const tabs = currentInventoryTabs();
  for (const record of stored ?? []) {
    const tab = tabs.find((item) => JSON.stringify(item.target) === JSON.stringify(record.target));
    if (tab && !owners.has(tab.target.tabId)) owners.set(tab.target.tabId, record.chatId);
  }
}

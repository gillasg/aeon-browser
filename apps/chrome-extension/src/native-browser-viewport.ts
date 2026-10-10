const overridden = new Set<number>();
chrome.tabs.onActivated?.addListener(({ tabId }) => void restoreBrowserViewport(tabId));
export async function ensureBrowserViewport(tabId: number): Promise<void> {
  if (overridden.has(tabId)) return;
  const tab = await chrome.tabs.get?.(tabId).catch(() => undefined);
  if (!tab) return;
  if (tab.active || ((tab as chrome.tabs.Tab & { splitViewId?: number }).splitViewId ?? -1) >= 0) {
    await restoreBrowserViewport(tabId);
    return;
  }
  await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  overridden.add(tabId);
}
export async function restoreBrowserViewport(tabId: number): Promise<void> {
  overridden.delete(tabId);
  await chrome.debugger
    .sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride")
    .catch(() => undefined);
}

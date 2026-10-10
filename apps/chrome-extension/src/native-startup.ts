/** Prepare on worker load, browser startup, and wake before a page requests a grant. */
export function installNativeStartup(connect: () => Promise<unknown>, retry: () => void): void {
  const warm = () => {
    void connect().catch(retry);
  };
  chrome.runtime.onStartup.addListener(warm);
  chrome.runtime.onInstalled.addListener(warm);
  chrome.tabs.onActivated.addListener(warm);
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId !== chrome.windows.WINDOW_ID_NONE) warm();
  });
  warm();
}

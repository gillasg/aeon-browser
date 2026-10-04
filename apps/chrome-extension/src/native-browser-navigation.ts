import { waitPageInteractive } from "./native-browser-readiness.js";
export async function navigateReady(
  tabId: number,
  url: string,
  timeoutMs = 8000,
): Promise<{ url: string; timedOut: boolean }> {
  const navigation = await new Promise<{ url: string; timedOut: boolean }>((resolve, reject) => {
    let committed = false;
    const top = (event: { tabId: number; frameId: number }) =>
      event.tabId === tabId && event.frameId === 0;
    const clean = () => {
      clearTimeout(timer);
      chrome.webNavigation.onCommitted.removeListener(commit);
      chrome.webNavigation.onDOMContentLoaded.removeListener(ready);
      chrome.webNavigation.onErrorOccurred.removeListener(error);
      chrome.webNavigation.onHistoryStateUpdated.removeListener(sameDocument);
      chrome.webNavigation.onReferenceFragmentUpdated.removeListener(sameDocument);
    };
    const finish = (nextUrl: string, timedOut = false) => {
      clean();
      resolve({ url: nextUrl, timedOut });
    };
    const commit = (event: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
      if (top(event)) committed = true;
    };
    const ready = (event: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
      if (top(event) && committed) finish(event.url);
    };
    const sameDocument = (event: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
      if (top(event)) finish(event.url);
    };
    const error = (event: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails) => {
      if (top(event) && !event.error.includes("ERR_ABORTED")) {
        clean();
        reject(new Error("OPERATION_FAILED"));
      }
    };
    const timer = setTimeout(
      () => {
        clean();
        void chrome.tabs
          .get(tabId)
          .then((tab) => resolve({ url: tab.url ?? url, timedOut: true }), reject);
      },
      Math.max(100, timeoutMs - 2000),
    );
    chrome.webNavigation.onCommitted.addListener(commit);
    chrome.webNavigation.onDOMContentLoaded.addListener(ready);
    chrome.webNavigation.onErrorOccurred.addListener(error);
    chrome.webNavigation.onHistoryStateUpdated.addListener(sameDocument);
    chrome.webNavigation.onReferenceFragmentUpdated.addListener(sameDocument);
    void chrome.tabs.update(tabId, { url }).catch((cause) => {
      clean();
      reject(cause);
    });
  });
  const interactive = await waitPageInteractive(tabId);
  return { ...navigation, timedOut: navigation.timedOut || !interactive };
}

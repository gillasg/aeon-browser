import { HANDOFF_EVENT, type HandoffAction } from "@aeon/ui";

/** Carries the chat's hand-off card buttons to the tab and to the waiting cell. */
export function installHandoffBridge(): void {
  window.addEventListener(HANDOFF_EVENT, (event) => {
    const { tabId, action } = (event as CustomEvent<{ tabId: number; action: HandoffAction }>)
      .detail;
    if (action === "focus") void focusTab(tabId);
    else void chrome.runtime.sendMessage({ kind: "aeon.handoff.answer", tabId, answer: action });
  });
}

async function focusTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
  if (tab) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
}

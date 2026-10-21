import { ORB_COMMAND, nonceKey, type OrbToggle, type OrbVerify } from "./orb-messages.js";

// The shortcut lives in the service worker. Pages Chrome keeps extensions out of
// (chrome://, the Web Store, the PDF viewer) get the side panel instead.

export function installOrb(): void {
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command === ORB_COMMAND) summon(tab);
  });
  chrome.runtime.onMessage.addListener((request: unknown, sender, sendResponse) => {
    const message = request as Partial<OrbVerify> | null;
    if (message?.kind !== "aeon.orb.verify" || sender.id !== chrome.runtime.id) return;
    void verify(message, sender).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  });
}

function summon(tab: chrome.tabs.Tab | undefined): void {
  if (tab?.id === undefined) return;
  if (!/^https?:/.test(tab.url ?? "")) {
    // Must run before any await: opening the side panel needs the shortcut's user gesture.
    if (tab.windowId !== undefined)
      void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
    return;
  }
  void toggle(tab.id);
}

async function toggle(tabId: number): Promise<void> {
  const nonce = crypto.randomUUID();
  await chrome.storage.session.set({ [nonceKey(nonce)]: tabId });
  // Only the first summon in a tab frames orb.html and uses its nonce; drop the rest.
  setTimeout(() => void chrome.storage.session.remove(nonceKey(nonce)), 30_000);
  const message: OrbToggle = { kind: "aeon.orb.toggle", tabId, nonce };
  try {
    await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch {
    // Tabs opened before Aeon loaded have no content script yet.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["orb-content.js"] });
    await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  }
}

async function verify(
  message: Partial<OrbVerify>,
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: boolean }> {
  if (
    typeof message.nonce !== "string" ||
    !sender.url?.startsWith(chrome.runtime.getURL("orb.html"))
  )
    return { ok: false };
  const key = nonceKey(message.nonce);
  const stored = (await chrome.storage.session.get(key))[key];
  await chrome.storage.session.remove(key);
  return { ok: stored === message.tabId && sender.tab?.id === message.tabId };
}

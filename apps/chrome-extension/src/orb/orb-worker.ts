import { isNeedsKey } from "./orb-control.js";
import {
  ORB_COMMAND,
  ORB_DISMISS,
  ORB_OFF,
  ORB_ON_KEY,
  ORB_RESTORE,
  nonceKey,
  type OrbToggle,
  type OrbVerify,
} from "./orb-messages.js";

// The shortcut lives in the service worker. Pages Chrome keeps extensions out of
// (chrome://, the Web Store, the PDF viewer) get the side panel instead. The worker also keeps
// the toolbar badge: how many runs need the user, else how many finished results are unread.
// The orb is a pet: once summoned it is on every web page (its box open where it was summoned,
// folded elsewhere) and comes back after every navigation and reload, until the shortcut, or a
// move to the side panel or a tab, dismisses it everywhere.

export function installOrb(): void {
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command === ORB_COMMAND) summon(tab);
  });
  chrome.runtime.onMessage.addListener((request: unknown, sender, sendResponse) => {
    const message = request as Partial<OrbVerify> | { kind?: unknown } | null;
    if (sender.id !== chrome.runtime.id) return;
    if (message?.kind === ORB_RESTORE) {
      void restore(sender.tab?.id).then(sendResponse, () => sendResponse(null));
      return true;
    }
    if (message?.kind === ORB_OFF) {
      void setOn(false);
      return;
    }
    if (message?.kind !== "aeon.orb.verify") return;
    void verify(message as Partial<OrbVerify>, sender).then(sendResponse, () =>
      sendResponse({ ok: false }),
    );
    return true;
  });
  chrome.storage.session.onChanged.addListener((changes) => {
    if (Object.keys(changes).some((key) => isNeedsKey(key) || key.startsWith(UNREAD_PREFIX)))
      void updateBadge();
  });
  void updateBadge();
}

const UNREAD_PREFIX = "piper-unread-";

async function updateBadge(): Promise<void> {
  const values = await chrome.storage.session.get(null);
  const keys = Object.keys(values);
  const needs = keys.filter(isNeedsKey).length;
  const unread = keys.filter((key) => key.startsWith(UNREAD_PREFIX)).length;
  const count = needs || unread;
  await chrome.action.setBadgeText({ text: count ? String(Math.min(count, 99)) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: needs ? "#c9a46a" : "#3f3f46" });
  await chrome.action.setTitle({
    title: needs
      ? `Aeon · ${needs} need${needs === 1 ? "s" : ""} you`
      : unread
        ? `Aeon · ${unread} new result${unread === 1 ? "" : "s"}`
        : "Open Aeon Chat",
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
  if (await isOn()) return setOn(false);
  await setOn(true);
  await present(tabId, true);
  // Every other web page gets the folded orb; frozen or unloaded tabs ask when they wake.
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }).catch(() => []);
  for (const tab of tabs)
    if (tab.id !== undefined && tab.id !== tabId && !tab.discarded)
      void present(tab.id, false).catch(() => undefined);
}

async function isOn(): Promise<boolean> {
  return (await chrome.storage.session.get(ORB_ON_KEY))[ORB_ON_KEY] === true;
}

async function setOn(on: boolean): Promise<void> {
  await chrome.storage.session.set({ [ORB_ON_KEY]: on });
  if (on) return;
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }).catch(() => []);
  for (const tab of tabs)
    if (tab.id !== undefined)
      void chrome.tabs
        .sendMessage(tab.id, { kind: ORB_DISMISS }, { frameId: 0 })
        .catch(() => undefined);
}

async function nonceFor(tabId: number): Promise<string> {
  const nonce = crypto.randomUUID();
  await chrome.storage.session.set({ [nonceKey(nonce)]: tabId });
  // A nonce frames orb.html once; an unused one expires.
  setTimeout(() => void chrome.storage.session.remove(nonceKey(nonce)), 30_000);
  return nonce;
}

/** A page that loaded (or woke) while the orb is on asks for it: a fresh nonce for that tab. */
async function restore(tabId: number | undefined): Promise<OrbToggle | null> {
  if (tabId === undefined || !(await isOn())) return null;
  return { kind: "aeon.orb.toggle", tabId, nonce: await nonceFor(tabId), open: false };
}

/**
 * A chat asked the user something (ask_user): the orb opens on the tab they are looking at,
 * showing that chat, so the question reaches them wherever they are. Pages Chrome keeps
 * extensions out of get the side panel's badge instead.
 */
export async function presentAsk(chatId: string): Promise<void> {
  const [tab] = await chrome.tabs
    .query({ active: true, lastFocusedWindow: true })
    .catch(() => [] as chrome.tabs.Tab[]);
  if (tab?.id === undefined || !/^https?:/.test(tab.url ?? "")) return;
  await chrome.storage.session.set({ ["aeon-orb-chat:" + tab.id]: chatId });
  await present(tab.id, true).catch(() => undefined);
}

async function present(tabId: number, open: boolean): Promise<void> {
  const message: OrbToggle = {
    kind: "aeon.orb.toggle",
    tabId,
    nonce: await nonceFor(tabId),
    open,
  };
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

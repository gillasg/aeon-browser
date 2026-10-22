import { learnUserTab, networkCall } from "@browser-use-extension/engine/native-browser-network";
import { askCore } from "./companion-requests.js";

// "Learn this site while I browse": a tab the user switches on from the orb records the site's
// own requests while they use it (Chrome shows its debugger bar meanwhile), and every 20 seconds
// and on each page load what it recorded is built into the site's API, with no model. Never on
// for every tab: one switch, one tab, until it is turned off or the tab closes.

const KEY = (tabId: number) => `aeon-learn:${tabId}`;
const EVERY_MS = 20_000;
const timers = new Map<number, number>();

export type BrowseLearning =
  | { kind: "aeon.learn.set"; tabId: number; on: boolean }
  | { kind: "aeon.learn.get"; tabId: number };

export function installBrowseLearning(): void {
  chrome.runtime.onMessage.addListener((request: unknown, sender, sendResponse) => {
    const message = request as BrowseLearning | null;
    if (sender.id !== chrome.runtime.id || typeof message?.tabId !== "number") return;
    if (message.kind === "aeon.learn.get") {
      void isLearning(message.tabId).then(sendResponse);
      return true;
    }
    if (message.kind !== "aeon.learn.set") return;
    void (message.on ? start(message.tabId) : stop(message.tabId)).then(
      () => sendResponse({ ok: true, on: message.on === true }),
      (error: unknown) => sendResponse({ ok: false, error: String(error) }),
    );
    return true;
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "complete" && timers.has(tabId)) void flush(tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => void stop(tabId));
  // The user closed Chrome's debugger bar: learning on that tab ends with it.
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined && timers.has(source.tabId)) void stop(source.tabId);
  });
}

async function isLearning(tabId: number): Promise<{ on: boolean }> {
  return { on: Boolean((await chrome.storage.session.get(KEY(tabId)))[KEY(tabId)]) };
}

async function start(tabId: number): Promise<void> {
  await learnUserTab(tabId, true);
  await chrome.storage.session.set({ [KEY(tabId)]: true });
  if (!timers.has(tabId))
    timers.set(
      tabId,
      globalThis.setInterval(() => void flush(tabId), EVERY_MS),
    );
}

async function stop(tabId: number): Promise<void> {
  const timer = timers.get(tabId);
  if (timer !== undefined) {
    globalThis.clearInterval(timer);
    timers.delete(tabId);
    await flush(tabId);
    await learnUserTab(tabId, false).catch(() => undefined);
  }
  await chrome.storage.session.remove(KEY(tabId));
}

/** Hands what the tab recorded to core, which builds it into the site's API. */
async function flush(tabId: number): Promise<void> {
  try {
    const har = (await networkCall(tabId, "take", {})) as { log?: { entries?: unknown[] } };
    if (!har.log?.entries?.length) return;
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !/^https?:/.test(tab.url)) return;
    await askCore("site", { action: "learn", site: new URL(tab.url).hostname, har });
  } catch {
    // Best effort: the tab may have closed or core restarted; the next flush tries again.
  }
}

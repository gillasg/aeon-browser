// The Manage tab is home.html: models, sites, watches and forms. It is never the New Tab page, so
// it opens on demand (the side panel's Manage button, the cursor's switcher) and once on install.
// An open Manage tab is reused and focused; only when none is open is a new one created.

export interface ManageTabLike {
  id?: number | undefined;
  windowId?: number | undefined;
  url?: string | undefined;
  active?: boolean | undefined;
  lastAccessed?: number | undefined;
}

/** A route inside Manage, like `#sites?host=flipkart.com`. Anything else is dropped. */
export function manageRoute(route: string | undefined): string {
  if (!route) return "";
  return /^#[a-z]+(\?[\w%.:=&-]*)?$/i.test(route) ? route : "";
}

export function manageSitesRoute(host: string): string {
  return host ? "#sites?host=" + encodeURIComponent(host) : "#sites";
}

/** The Manage tab to reuse: one showing home.html (not a chat list or panel frame), most recent first. */
export function pickManageTab<T extends ManageTabLike>(
  tabs: readonly T[],
  base: string,
): T | undefined {
  const own = tabs.filter((tab) => tab.id !== undefined && isManageUrl(tab.url, base));
  return own.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}

function isManageUrl(url: string | undefined, base: string): boolean {
  if (!url || !url.startsWith(base)) return false;
  const rest = url.slice(base.length);
  return !/[?&]host=panel\b/.test(rest);
}

export async function openManage(route?: string): Promise<void> {
  const base = chrome.runtime.getURL("home.html");
  const hash = manageRoute(route);
  const tabs = await chrome.tabs.query({ url: base + "*" }).catch(() => []);
  const tab = pickManageTab(tabs, base);
  if (tab?.id === undefined) {
    await chrome.tabs.create({ url: base + hash });
    return;
  }
  const url = hash ? (tab.url ?? base).replace(/#.*$/, "") + hash : undefined;
  await chrome.tabs.update(tab.id, { active: true, ...(url ? { url } : {}) });
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
}

/** Set in chrome.storage.local (or a webdriver-driven browser) to skip the first-install tab. */
export const WELCOME_DISABLED_KEY = "aeon-welcome-disabled";

/** Whether a fresh install should open the welcome tab: installs only, never updates or tests. */
export function shouldWelcome(reason: string, disabled: unknown, automated: boolean): boolean {
  return reason === "install" && disabled !== true && !automated;
}

/** First run only: a quiet welcome tab with the connection status and the first commands. */
export function installManageOnFirstRun(): void {
  chrome.runtime.onInstalled.addListener((details) => {
    void chrome.storage.local
      .get(WELCOME_DISABLED_KEY)
      .then((items) => {
        const automated = (globalThis.navigator as { webdriver?: boolean } | undefined)?.webdriver;
        if (shouldWelcome(details.reason, items[WELCOME_DISABLED_KEY], automated === true))
          return chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
        return undefined;
      })
      .catch(() => undefined);
  });
}

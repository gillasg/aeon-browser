// Manage → Sites → Teach Graft. The page only asks; the worker opens the site in front, starts the
// same Teach recorder the cursor's pill drives, and opens the cursor there so its Teach pill shows.
// (Done in the page, the work died with the Manage tab before the recorder started.)

import { startTeaching } from "./browse-learning.js";

export const TEACH_SITE = "graft.teach.site";
const LOAD_MS = 15_000;

/** In the Manage page: hand the request to the worker. */
export function teachSite(host: string): void {
  void chrome.runtime.sendMessage({ kind: TEACH_SITE, host }).catch(() => undefined);
}

/** In the worker. `present` opens the cursor on the tab. */
export async function teachSiteInWorker(
  host: string,
  present: (tabId: number) => Promise<void>,
): Promise<void> {
  const clean = host.trim().replace(/^https?:\/\//, "");
  if (!clean) return;
  const scheme = /^(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(clean) ? "http" : "https";
  const tab = await chrome.tabs.create({ url: `${scheme}://${clean}`, active: true });
  if (tab.id === undefined) return;
  await loaded(tab.id);
  try {
    await startTeaching(tab.id);
  } catch {
    // A late redirect can momentarily detach/reject the first attach; retry once.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await startTeaching(tab.id);
  }
  await present(tab.id);
}

function loaded(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listen);
      resolve();
    };
    const listen = (id: number, change: { status?: string }): void => {
      if (id === tabId && change.status === "complete") done();
    };
    const timer = setTimeout(done, LOAD_MS);
    chrome.tabs.onUpdated.addListener(listen);
    // Avoid stalling for LOAD_MS when the tab already completed before the listener attached.
    void chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") done();
      })
      .catch(() => undefined);
  });
}

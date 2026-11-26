// Chrome can swap a tab for another (prerender, instant pages): the old id is gone and the page
// lives on under a new one. Opening a tab follows that swap instead of reporting TARGET_LOST.

const TTL_MS = 60_000;
const MAX_ENTRIES = 200;
const replaced = new Map<number, { addedTabId: number; at: number }>();

/** Records that Chrome replaced `removedTabId` with `addedTabId`. Bounded in age and size. */
export function noteReplacement(addedTabId: number, removedTabId: number, now = Date.now()): void {
  replaced.delete(removedTabId);
  replaced.set(removedTabId, { addedTabId, at: now });
  for (const [key, entry] of replaced)
    if (replaced.size > MAX_ENTRIES || now - entry.at > TTL_MS) replaced.delete(key);
    else break;
}

/** The tab that now holds `tabId`'s page, following chains of swaps (A -> B -> C). */
export function followReplacement(tabId: number, now = Date.now()): number {
  let id = tabId;
  for (let hops = 0; hops < MAX_ENTRIES; hops++) {
    const next = replaced.get(id);
    if (!next || now - next.at > TTL_MS) break;
    id = next.addedTabId;
  }
  return id;
}

export function clearReplacements(): void {
  replaced.clear();
}

const onReplaced = globalThis.chrome?.tabs?.onReplaced;
if (onReplaced) onReplaced.addListener((added, removed) => noteReplacement(added, removed));

/**
 * The opened tab's inventory entry, under its current id. A miss checks the tab still exists
 * (following a swap that landed meanwhile) and asks once more before giving up.
 */
export async function settleOpenedTab<T>(
  openedId: number,
  refresh: (tabId: number) => Promise<T | undefined>,
): Promise<{ id: number; tab: T | undefined }> {
  let id = followReplacement(openedId);
  if (id !== openedId) console.warn(`[warn] opened tab ${openedId} was replaced by tab ${id}`);
  const tab = await refresh(id);
  if (tab) return { id, tab };
  console.warn(`[warn] opened tab ${id} missing from the inventory; checking Chrome`);
  const live = await chrome.tabs.get(id).catch(() => undefined);
  const again = followReplacement(id);
  if (!live && again === id) return { id, tab: undefined };
  id = live?.id ?? again;
  return { id, tab: await refresh(id) };
}

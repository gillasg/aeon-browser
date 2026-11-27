// A tab that closes inside a cell (try { … } finally { await browser.closeTab(tab) }) still
// taught something: what it recorded and had not handed over yet is kept here, bounded, until
// the cell's end-of-cell learning takes it. Without this, well-behaved cells learn nothing.
import { takeLearned, type Taking } from "./native-browser-network-learn.js";

const MAX_TABS = 20;
const MAX_AGE_MS = 10 * 60_000;

interface Kept {
  har: unknown;
  url?: string;
  at: number;
}

const kept = new Map<number, Kept>();

const entriesOf = (har: unknown): { request?: { url?: string } }[] =>
  ((har as { log?: { entries?: unknown[] } } | undefined)?.log?.entries ?? []) as {
    request?: { url?: string };
  }[];

/** Called on close, before the tab's recording is dropped. */
export function keepClosedTab(tabId: number, recorder: Taking | undefined): void {
  if (!recorder) return;
  const har = takeLearned(recorder);
  const entries = entriesOf(har);
  if (!entries.length) return;
  const url = entries[0]?.request?.url;
  kept.set(tabId, { har, at: Date.now(), ...(url ? { url } : {}) });
  prune();
}

/** What closed tabs recorded, for the given tab ids; each is handed over once. */
export function takeClosedTabs(
  tabIds: readonly number[],
): { tabId: number; har: unknown; url?: string }[] {
  prune();
  const out: { tabId: number; har: unknown; url?: string }[] = [];
  for (const tabId of tabIds) {
    const item = kept.get(tabId);
    if (!item) continue;
    kept.delete(tabId);
    out.push({ tabId, har: item.har, ...(item.url ? { url: item.url } : {}) });
  }
  return out;
}

function prune(): void {
  const now = Date.now();
  for (const [tabId, item] of kept) if (now - item.at > MAX_AGE_MS) kept.delete(tabId);
  while (kept.size > MAX_TABS) kept.delete(kept.keys().next().value as number);
}

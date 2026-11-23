import { learnUserTab, networkCall } from "@browserkit/engine/native-browser-network";
import { askCore } from "./companion-requests.js";

// "Learn this site while I browse": a tab the user switches on from the orb records the site's
// own requests while they use it (Chrome shows its debugger bar meanwhile), and every 20 seconds
// and on each page load what it recorded is built into the site's API, with no model. Never on
// for every tab: one switch, one tab, until it is turned off or the tab closes.

const KEY = (tabId: number) => `aeon-learn:${tabId}`;
/** The last session's result, so an orb that only sees learning end (the user closed Chrome's
 * debugger bar) can still say what was learned. */
const DONE_KEY = (tabId: number) => `aeon-learned:${tabId}`;

/**
 * What a teaching tab started from, per site it visited, so the count is the APIs this session
 * added. Teaching often starts on one page and browses to the site that matters; a baseline taken
 * only for the first host used to count nothing there.
 */
interface Teaching {
  site: string;
  baselines: Record<string, string[]>;
  found: number;
}
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
    const change = message.on
      ? start(message.tabId).then(() => ({ found: 0 }))
      : stop(message.tabId);
    void change.then(
      (result) => sendResponse({ ok: true, on: message.on === true, ...result }),
      (error: unknown) => sendResponse({ ok: false, error: String(error) }),
    );
    return true;
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "complete") void whileTeaching(tabId, () => flush(tabId));
  });
  chrome.tabs.onRemoved.addListener((tabId) => void stop(tabId));
  // The user closed Chrome's debugger bar: learning on that tab ends with it.
  chrome.debugger.onDetach.addListener((source) => {
    const tabId = source.tabId;
    if (tabId !== undefined) void whileTeaching(tabId, () => stop(tabId));
  });
}

/** Runs `then` when the tab is teaching: the in-memory timer, or (after Chrome slept this worker
 * and cleared it) the session record that outlives it. */
export async function whileTeaching(tabId: number, then: () => Promise<unknown>): Promise<void> {
  if (!timers.has(tabId) && !(await teaching(tabId))) return;
  await then();
}

async function teaching(tabId: number): Promise<Teaching | undefined> {
  const value = (await chrome.storage.session.get(KEY(tabId)))[KEY(tabId)] as unknown;
  if (!value) return undefined;
  const item = value as Partial<Teaching> & { baseline?: unknown };
  const site = typeof item.site === "string" ? item.site : "";
  const baselines: Record<string, string[]> = {};
  if (item.baselines && typeof item.baselines === "object")
    for (const [host, ids] of Object.entries(item.baselines))
      if (Array.isArray(ids)) baselines[host] = ids.map(String);
  if (site && !baselines[site] && Array.isArray(item.baseline))
    baselines[site] = item.baseline.map(String);
  return { site, baselines, found: Number(item.found) || 0 };
}

async function isLearning(tabId: number): Promise<{ on: boolean; found: number; site: string }> {
  const state = await teaching(tabId);
  if (state) return { on: true, found: state.found, site: state.site };
  const done = (await chrome.storage.session.get(DONE_KEY(tabId)))[DONE_KEY(tabId)] as
    { found?: unknown; site?: unknown } | undefined;
  return {
    on: false,
    found: Number(done?.found) || 0,
    site: typeof done?.site === "string" ? done.site : "",
  };
}

/** The ids of the operations a site has mapped, or none when it is not mapped yet. */
async function operationIds(site: string): Promise<string[]> {
  if (!site) return [];
  const rows = await askCore("site", { action: "operations", site }).catch(() => []);
  return Array.isArray(rows)
    ? rows.flatMap((row) => {
        const id = (row as { id?: unknown } | null)?.id;
        return typeof id === "string" ? [id] : [];
      })
    : [];
}

/** Distinct mapped operations this teaching session added: APIs, not raw requests. */
export function newOperationCount(baseline: readonly string[], now: readonly string[]): number {
  const before = new Set(baseline);
  return new Set(now.filter((id) => !before.has(id))).size;
}

async function tabSite(tabId: number): Promise<string> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  return tab?.url && /^https?:/.test(tab.url) ? new URL(tab.url).hostname : "";
}

/** Starts Teach on a tab from the worker itself (Manage → Sites → Teach Aeon). */
export function startTeaching(tabId: number): Promise<void> {
  return start(tabId);
}

async function start(tabId: number): Promise<void> {
  await learnUserTab(tabId, true);
  const site = await tabSite(tabId);
  const state: Teaching = {
    site,
    baselines: site ? { [site]: await operationIds(site) } : {},
    found: 0,
  };
  await chrome.storage.session.remove(DONE_KEY(tabId));
  await chrome.storage.session.set({ [KEY(tabId)]: state });
  if (!timers.has(tabId))
    timers.set(
      tabId,
      globalThis.setInterval(() => void flush(tabId), EVERY_MS),
    );
}

async function stop(tabId: number): Promise<{ found: number; site: string }> {
  const state = await teaching(tabId);
  const timer = timers.get(tabId);
  if (timer !== undefined) globalThis.clearInterval(timer);
  timers.delete(tabId);
  if (timer !== undefined || state !== undefined) {
    await flush(tabId);
    await learnUserTab(tabId, false).catch(() => undefined);
  }
  // Re-read: the flush above may have moved the session to the site the user browsed to.
  const latest = (await teaching(tabId)) ?? state;
  const found = latest ? await countFound(tabId, latest) : 0;
  const site = latest?.site ?? "";
  await chrome.storage.session.remove(KEY(tabId));
  if (latest) await chrome.storage.session.set({ [DONE_KEY(tabId)]: { found, site } });
  return { found, site };
}

async function countFound(tabId: number, state: Teaching): Promise<number> {
  let found = 0;
  for (const [host, baseline] of Object.entries(state.baselines))
    found += newOperationCount(baseline, await operationIds(host));
  if (timers.has(tabId) || (await teaching(tabId)))
    await chrome.storage.session.set({ [KEY(tabId)]: { ...state, found } });
  return found;
}

/** The first flush on a new host takes its baseline before anything is learned there. */
async function onSite(tabId: number, host: string): Promise<void> {
  const state = await teaching(tabId);
  if (!state || (state.site === host && state.baselines[host])) return;
  const baselines = state.baselines[host]
    ? state.baselines
    : { ...state.baselines, [host]: await operationIds(host) };
  await chrome.storage.session.set({ [KEY(tabId)]: { ...state, site: host, baselines } });
}

/** Hands what the tab recorded to core, which builds it into the site's API. */
async function flush(tabId: number): Promise<void> {
  try {
    const har = (await networkCall(tabId, "take", {})) as { log?: { entries?: unknown[] } };
    if (!har.log?.entries?.length) return;
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !/^https?:/.test(tab.url)) return;
    const host = new URL(tab.url).hostname;
    await onSite(tabId, host);
    await askCore("site", { action: "learn", site: host, har });
    const state = await teaching(tabId);
    if (state) await countFound(tabId, state);
  } catch {
    // Best effort: the tab may have closed or core restarted; the next flush tries again.
  }
}

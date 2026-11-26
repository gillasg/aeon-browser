// Linux and Windows quit Chrome when the last tab of the last window closes. macOS keeps Chrome
// running but closes the window, which loses the user's only window. On every platform a blank
// tab is opened first in that same window, and closes run one at a time, so the requested close
// still happens.

export interface TabCloser {
  query(): Promise<Array<{ id?: number | undefined; windowId?: number | undefined }>>;
  create(tab: { url: string; active: boolean; windowId?: number }): Promise<unknown>;
  remove(tabIds: number | number[]): Promise<unknown>;
}

const BLANK = "about:blank";
/** A tab call that has not settled by now is treated as failed so later closes still run. */
export const TAB_OP_TIMEOUT_MS = 6_000;

/** Settles with a timeout error when `work` has not settled within `ms`. */
export function withTabTimeout<T>(
  work: Promise<T>,
  what: string,
  ms = TAB_OP_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  return Promise.race([Promise.resolve(work), timeout]).finally(() => clearTimeout(timer));
}

let tail: Promise<void> = Promise.resolve();
let guardInstalled = false;

/** Removes tabs, leaving one blank tab when the close would otherwise quit Chrome. */
export function closeTabsKeepingBrowser(tabIds: number | number[], api: TabCloser): Promise<void> {
  const batch = listed(tabIds);
  const run = tail.then(() => closeNow(batch, api));
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Wraps tab removal and Page.close. Skips a Chrome object that has no tab API (unit tests). */
export function installLastTabGuard(): void {
  if (guardInstalled) return;
  const tabs = browserChrome()?.tabs;
  if (!hasTabApi(tabs)) return;
  guardInstalled = true;
  wrapRemove(tabs);
  wrapPageClose();
}

function listed(tabIds: number | number[]): { ids: number[]; shape: number | number[] } {
  if (!Array.isArray(tabIds)) {
    return isTabId(tabIds) ? { ids: [tabIds], shape: tabIds } : { ids: [], shape: tabIds };
  }
  const ids = tabIds.filter(isTabId);
  return { ids, shape: ids };
}

function isTabId(id: unknown): id is number {
  return typeof id === "number" && Number.isInteger(id);
}

async function closeNow(
  batch: { ids: number[]; shape: number | number[] },
  api: TabCloser,
): Promise<void> {
  if (batch.ids.length === 0) return;
  const keep = await lastTabs(batch.ids, api);
  if (keep.last) {
    await withTabTimeout(
      api.create({
        url: BLANK,
        active: false,
        ...(keep.windowId === undefined ? {} : { windowId: keep.windowId }),
      }),
      "Opening the keep-alive tab",
    );
  }
  await withTabTimeout(api.remove(batch.shape), "Tab close");
}

/** True when the close would leave no tab at all; names the window that should keep one. */
export async function lastTabs(
  ids: number[],
  api: TabCloser,
): Promise<{ last: boolean; windowId?: number }> {
  const open = await withTabTimeout(api.query(), "Tab lookup").catch(() => []);
  const openIds = open.map((tab) => tab.id).filter(isTabId);
  if (openIds.length === 0) return { last: false };
  const closing = new Set(ids);
  if (!openIds.every((id) => closing.has(id))) return { last: false };
  const windowId = open.find((tab) => typeof tab.windowId === "number")?.windowId;
  return windowId === undefined ? { last: true } : { last: true, windowId };
}

function browserChrome(): typeof chrome | undefined {
  return (globalThis as { chrome?: typeof chrome }).chrome;
}

function hasTabApi(tabs: typeof chrome.tabs | undefined): tabs is typeof chrome.tabs {
  return tabs !== undefined && "remove" in tabs && "query" in tabs && "create" in tabs;
}

function wrapRemove(tabs: typeof chrome.tabs): void {
  const original = tabs.remove.bind(tabs);
  const api: TabCloser = {
    query: () =>
      tabs.query({}).then((open) => open.map((tab) => ({ id: tab.id, windowId: tab.windowId }))),
    create: (tab) => tabs.create(tab),
    remove: (ids) => (Array.isArray(ids) ? original(ids) : original(ids)),
  };
  tabs.remove = ((tabIds: number | number[], callback?: () => void) => {
    const work = closeTabsKeepingBrowser(tabIds, api);
    if (typeof callback === "function") {
      void work.then(
        () => callback(),
        () => callback(),
      );
    }
    return work;
  }) as typeof tabs.remove;
}

function closedPage(tabId: number): Promise<object> {
  const tabs = browserChrome()?.tabs;
  if (!tabs) return Promise.resolve({});
  return Promise.resolve(tabs.remove(tabId)).then(() => ({}));
}

function wrapPageClose(): void {
  const dbg = browserChrome()?.debugger;
  if (!dbg || !("sendCommand" in dbg)) return;
  try {
    const original = dbg.sendCommand.bind(dbg) as (
      debuggee: chrome.debugger.Debuggee,
      method: string,
      params?: object,
      callback?: (result?: object) => void,
    ) => unknown;
    dbg.sendCommand = ((
      debuggee: chrome.debugger.Debuggee,
      method: string,
      params?: object,
      callback?: (result?: object) => void,
    ) => {
      if (method !== "Page.close" || typeof debuggee?.tabId !== "number") {
        return original(debuggee, method, params, callback);
      }
      const work = closedPage(debuggee.tabId);
      if (typeof callback === "function") {
        void work.then(
          (result) => callback(result),
          () => callback(),
        );
      }
      return work;
    }) as typeof dbg.sendCommand;
  } catch {
    // A frozen debugger API cannot be wrapped; Page.close then stays native.
  }
}

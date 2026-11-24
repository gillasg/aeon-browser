// browser.workspaces, page.pip() and browser.suspension: the user's own tab groups, named
// workspaces saved as {title, color, urls} only, picture-in-picture, and a governor that keeps
// watcher tabs from being discarded and discards stale background tabs on request. Nothing
// runs until a call asks; Chrome is passed in so tests can stub it.
import type { Cdp } from "./native-browser-visual-claws.js";

type Value = Record<string, unknown>;
type Tab = chrome.tabs.Tab;
const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const STORE_KEY = "aeon-workspaces";
const MAX_WORKSPACES = 50;
const MAX_URLS = 100;

export interface SavedGroup {
  title: string;
  color: string;
  urls: string[];
}
export interface Workspace {
  name: string;
  savedAt: number;
  groups: SavedGroup[];
}

export interface WorkspaceChrome {
  tabs: Pick<typeof chrome.tabs, "query" | "group" | "ungroup" | "update" | "discard" | "create">;
  tabGroups: Pick<typeof chrome.tabGroups, "query" | "update">;
  storage: {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  now?: () => number;
}

const tabIds = (value: unknown): number[] => {
  const ids = (Array.isArray(value) ? value : [value]).map(Number).filter(Number.isInteger);
  if (!ids.length) throw new Error("INVALID_INPUT: give one or more tab ids");
  return ids;
};

function groupPatch(value: Value): chrome.tabGroups.UpdateProperties {
  const patch: chrome.tabGroups.UpdateProperties = {};
  if (typeof value.title === "string") patch.title = value.title.slice(0, 80);
  if (value.color !== undefined) {
    if (!COLORS.includes(String(value.color)))
      throw new Error("INVALID_INPUT: color is one of " + COLORS.join(", "));
    patch.color = value.color as chrome.tabGroups.Color;
  }
  if (typeof value.collapsed === "boolean") patch.collapsed = value.collapsed;
  return patch;
}

const httpUrl = (url: string | undefined): url is string => /^https?:\/\//.test(url ?? "");

async function loadSaved(api: WorkspaceChrome): Promise<Workspace[]> {
  const stored = (await api.storage.get(STORE_KEY))[STORE_KEY];
  return Array.isArray(stored) ? (stored as Workspace[]) : [];
}

async function saveWorkspace(api: WorkspaceChrome, name: string): Promise<unknown> {
  const groups = await api.tabGroups.query({});
  const tabs = await api.tabs.query({});
  const saved: SavedGroup[] = groups
    .map((group) => ({
      title: group.title ?? "",
      color: group.color,
      urls: tabs
        .filter((tab) => tab.groupId === group.id)
        .map((tab) => tab.url)
        .filter(httpUrl)
        .slice(0, MAX_URLS),
    }))
    .filter((group) => group.urls.length);
  const now = (api.now ?? Date.now)();
  const all = (await loadSaved(api)).filter((entry) => entry.name !== name);
  all.push({ name, savedAt: now, groups: saved });
  await api.storage.set({ [STORE_KEY]: all.slice(-MAX_WORKSPACES) });
  return {
    saved: name,
    groups: saved.length,
    tabs: saved.reduce((n, group) => n + group.urls.length, 0),
  };
}

async function restoreWorkspace(api: WorkspaceChrome, name: string): Promise<unknown> {
  const entry = (await loadSaved(api)).find((item) => item.name === name);
  if (!entry) throw new Error(`INVALID_INPUT: no saved workspace named ${name}`);
  const restored: { groupId: number; title: string; tabIds: number[] }[] = [];
  for (const group of entry.groups) {
    const ids: number[] = [];
    for (const url of group.urls.filter(httpUrl)) {
      const tab = await api.tabs.create({ url, active: false });
      if (tab.id !== undefined) ids.push(tab.id);
    }
    if (!ids.length) continue;
    const groupId = await api.tabs.group({ tabIds: ids as [number, ...number[]] });
    await api.tabGroups.update(groupId, {
      title: group.title,
      color: group.color as chrome.tabGroups.Color,
    });
    restored.push({ groupId, title: group.title, tabIds: ids });
  }
  return { restored: name, groups: restored };
}

async function workspaceAction(api: WorkspaceChrome, value: Value): Promise<unknown> {
  const name = String(value.name ?? "")
    .trim()
    .slice(0, 80);
  const needName = () => {
    if (!name) throw new Error("INVALID_INPUT: give the workspace a name");
  };
  switch (value.workspaces) {
    case "list":
      return {
        groups: (await api.tabGroups.query({})).map((g) => ({
          groupId: g.id,
          title: g.title ?? "",
          color: g.color,
          collapsed: g.collapsed,
          windowId: g.windowId,
        })),
      };
    case "group": {
      const groupId = await api.tabs.group({
        tabIds: tabIds(value.tabIds) as [number, ...number[]],
        ...(Number.isInteger(value.groupId) ? { groupId: value.groupId as number } : {}),
      });
      const patch = groupPatch(value);
      if (Object.keys(patch).length) await api.tabGroups.update(groupId, patch);
      return { groupId };
    }
    case "ungroup":
      await api.tabs.ungroup(tabIds(value.tabIds) as [number, ...number[]]);
      return { ungrouped: tabIds(value.tabIds) };
    case "update":
      if (!Number.isInteger(value.groupId)) throw new Error("INVALID_INPUT: give a groupId");
      await api.tabGroups.update(value.groupId as number, groupPatch((value.patch ?? {}) as Value));
      return { groupId: value.groupId, updated: true };
    case "save":
      needName();
      return saveWorkspace(api, name);
    case "restore":
      needName();
      return restoreWorkspace(api, name);
    case "listSaved":
      return {
        workspaces: (await loadSaved(api)).map((w) => ({
          name: w.name,
          savedAt: w.savedAt,
          groups: w.groups.length,
        })),
      };
    case "removeSaved": {
      needName();
      const all = await loadSaved(api);
      const kept = all.filter((entry) => entry.name !== name);
      await api.storage.set({ [STORE_KEY]: kept });
      return { removed: kept.length !== all.length };
    }
    default:
      throw new Error(
        "INVALID_INPUT: workspaces is list, group, ungroup, update, save, restore, listSaved or removeSaved",
      );
  }
}

// Tabs the governor protects; Chrome keeps the flag itself, this is only for status().
const protectedTabs = new Set<number>();

export function eligibleForSuspension(tab: Tab, options: Value, now: number): boolean {
  const exclude = new Set(
    Array.isArray(options.excludeTabIds) ? options.excludeTabIds.map(Number) : [],
  );
  const olderThanMs = Math.max(0, Number(options.olderThanMs) || 0);
  if (tab.id === undefined || exclude.has(tab.id) || tab.discarded) return false;
  if (tab.autoDiscardable === false || protectedTabs.has(tab.id)) return false;
  if (options.keepPinned !== false && tab.pinned) return false;
  if (options.keepAudible !== false && tab.audible) return false;
  if (options.keepActive !== false && tab.active) return false;
  const lastAccessed = (tab as Tab & { lastAccessed?: number }).lastAccessed;
  if (olderThanMs && typeof lastAccessed === "number" && now - lastAccessed < olderThanMs)
    return false;
  return true;
}

async function governorAction(api: WorkspaceChrome, value: Value): Promise<unknown> {
  switch (value.suspension) {
    case "protect": {
      const tabId = Number(value.tabId);
      if (!Number.isInteger(tabId)) throw new Error("INVALID_INPUT: give a tab id");
      const keep = value.protected !== false;
      await api.tabs.update(tabId, { autoDiscardable: !keep });
      if (keep) protectedTabs.add(tabId);
      else protectedTabs.delete(tabId);
      return { tabId, protected: keep };
    }
    case "suspendIdle": {
      const now = (api.now ?? Date.now)();
      const options = (value.options ?? {}) as Value;
      const tabs = await api.tabs.query({});
      const suspendedTabIds: number[] = [];
      let skippedCount = 0;
      for (const tab of tabs) {
        if (!eligibleForSuspension(tab, options, now)) {
          skippedCount++;
          continue;
        }
        const done = await api.tabs.discard(tab.id as number).catch(() => undefined);
        if (done) suspendedTabIds.push(tab.id as number);
        else skippedCount++;
      }
      return { suspendedTabIds, skippedCount };
    }
    case "status": {
      const tabs = await api.tabs.query({});
      return {
        tabs: tabs.length,
        active: tabs.filter((tab) => tab.active).length,
        discarded: tabs.filter((tab) => tab.discarded).length,
        protected: tabs.filter((tab) => tab.autoDiscardable === false).length,
      };
    }
    default:
      throw new Error("INVALID_INPUT: suspension is protect, suspendIdle or status");
  }
}

export function workspacesCall(api: WorkspaceChrome, value: Value): Promise<unknown> {
  return typeof value.suspension === "string"
    ? governorAction(api, value)
    : workspaceAction(api, value);
}

// Runs in the page with a user gesture: video PiP for a <video>, else Document PiP, or status.
const PIP = String(
  async (arg: { action: string; selector?: string; width?: number; height?: number }) => {
    const doc = document as Document & {
      pictureInPictureElement?: Element | null;
      exitPictureInPicture?: () => Promise<void>;
    };
    const docPip = (
      window as unknown as {
        documentPictureInPicture?: {
          window: Window | null;
          requestWindow(o: object): Promise<Window>;
        };
      }
    ).documentPictureInPicture;
    const status = () => ({
      videoSupported: Boolean(doc.pictureInPictureEnabled),
      documentSupported: Boolean(docPip),
      active: Boolean(doc.pictureInPictureElement) || Boolean(docPip?.window),
      mode: doc.pictureInPictureElement ? "video" : docPip?.window ? "document" : "none",
    });
    if (arg.action === "exit") {
      if (doc.pictureInPictureElement) await doc.exitPictureInPicture?.();
      docPip?.window?.close();
      return { ...status(), exited: true };
    }
    if (arg.action === "enter") {
      const video = document.querySelector(arg.selector || "video") as HTMLVideoElement | null;
      if (video && doc.pictureInPictureEnabled && !video.disablePictureInPicture) {
        await video.requestPictureInPicture();
      } else if (docPip) {
        const pip = await docPip.requestWindow({
          width: arg.width ?? 480,
          height: arg.height ?? 320,
        });
        const source = arg.selector ? document.querySelector(arg.selector) : null;
        if (source) pip.document.body.append(source.cloneNode(true));
      } else
        return { ...status(), entered: false, reason: "UNSUPPORTED: no picture-in-picture here" };
      return { ...status(), entered: true };
    }
    return status();
  },
);

export async function pipCall(cdp: Cdp, value: Value): Promise<unknown> {
  const action = ["enter", "exit", "status"].includes(String(value.action))
    ? String(value.action)
    : "status";
  const answer = (await cdp("Runtime.evaluate", {
    expression: `(${PIP})(${JSON.stringify({ action, selector: value.selector, width: value.width, height: value.height })})`,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (answer?.exceptionDetails)
    return {
      entered: false,
      reason: String(
        answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text,
      ).slice(0, 200),
    };
  return answer?.result?.value;
}

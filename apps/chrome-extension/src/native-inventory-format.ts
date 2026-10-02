import {
  BrowserTabSchema,
  BrowserWindowSchema,
  type BrowserTab,
  type BrowserWindow,
} from "@pippin/protocol";
import type { BrowserIdentity } from "./native-worker-identity.js";

export type TabIdentity = { tabIncarnation: string; documentEpoch: number };

export function toInventoryWindow(window: chrome.windows.Window): BrowserWindow {
  const state = window.state ?? "normal";
  return BrowserWindowSchema.parse({
    windowId: window.id,
    focused: window.focused ?? false,
    state: ["normal", "minimized", "maximized", "fullscreen"].includes(state) ? state : "normal",
    type: window.type === "popup" ? "popup" : "normal",
  });
}

export function toInventoryTab(
  tab: chrome.tabs.Tab,
  identity: BrowserIdentity,
  state: TabIdentity,
): BrowserTab {
  return BrowserTabSchema.parse({
    target: {
      ...inventoryIdentity(identity),
      tabId: tab.id as number,
      tabIncarnation: state.tabIncarnation,
    },
    windowId: tab.windowId,
    index: tab.index,
    url: tab.url ?? "",
    title: tab.title ?? "",
    status: tab.discarded ? "discarded" : tab.status === "complete" ? "complete" : "loading",
    active: tab.active,
    pinned: tab.pinned,
    groupId: tab.groupId ?? -1,
    documentEpoch: state.documentEpoch,
  });
}

export function inventoryIdentity(identity: BrowserIdentity): BrowserIdentity {
  return { clientInstanceId: identity.clientInstanceId, browserRunId: identity.browserRunId };
}

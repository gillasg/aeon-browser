// Kernel effects for the visual, media-tap and workspace claws. Each builds its DevTools channel
// only when a call arrives, so an idle tab costs nothing.
import { withDebugger } from "./native-browser-debugger.js";
import { send } from "./cdp/send.js";
import { visualCall, forgetVisual, type Cdp } from "./native-browser-visual-claws.js";
import { forgetCaptions, mediaTapCall } from "./native-browser-media-tap.js";
import { pipCall, workspacesCall, type WorkspaceChrome } from "./native-browser-workspaces.js";

type Value = Record<string, unknown>;

const cdpFor =
  (tabId: number, label: string): Cdp =>
  (method, params) =>
    withDebugger(tabId, (debuggee) => send(debuggee, method, params, { label }));

let closeHooked = false;
function onClosed(listener: (tabId: number) => void): void {
  if (closeHooked) return;
  closeHooked = true;
  chrome.tabs.onRemoved.addListener((tabId) => {
    listener(tabId);
    forgetVisual(tabId);
    forgetCaptions(tabId);
  });
}

const workspaceChrome = (): WorkspaceChrome => ({
  tabs: chrome.tabs,
  tabGroups: chrome.tabGroups,
  storage: {
    get: (key) => chrome.storage.local.get(key),
    set: (items) => chrome.storage.local.set(items),
  },
});

export function visualEffect(value: Value, tabId: number): Promise<unknown> {
  onClosed(() => undefined);
  return visualCall(tabId, value, cdpFor(tabId, "visual"));
}

export function mediaTapEffect(value: Value, tabId: number): Promise<unknown> {
  return mediaTapCall(tabId, value, {
    cdp: cdpFor(tabId, "mediaTap"),
    tabs: chrome.tabs,
    onClosed,
  });
}

export function pipEffect(value: Value, tabId: number): Promise<unknown> {
  return pipCall(cdpFor(tabId, "pip"), { ...value, action: value.pip });
}

export function workspacesEffect(value: Value): Promise<unknown> {
  return workspacesCall(workspaceChrome(), value);
}

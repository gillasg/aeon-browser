import {
  BrowserContextHandoffSchema,
  PiBrowserContextRecordSchema,
  type BrowserTargetKey,
  type PiBrowserContextRecord,
} from "@pippin/protocol";
import { currentInventoryTabs, refreshInventoryTab } from "./native-inventory-client.js";
import { handoffKey } from "./browser-context-storage.js";

const MENU_ASK_SELECTION = "pippin.ask-selection";
const MENU_SUMMARIZE = "pippin.summarize-page";
const MENU_ADD_CONTEXT = "pippin.add-page-context";

export function installNativeBrowserContextMenus(ensureExecutor: () => Promise<unknown>): void {
  chrome.contextMenus.onClicked.addListener((info, tab) =>
    handleContextMenuClick(info, tab, ensureExecutor),
  );
  chrome.runtime.onInstalled.addListener(() => registerMenus());
  chrome.runtime.onStartup.addListener(() => registerMenus());
  registerMenus();
}

function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
  ensureExecutor: () => Promise<unknown>,
): void {
  if (!isContextMenuClick(info, tab)) return;
  if (tab.windowId !== undefined && isSafePageUrl(info.pageUrl ?? tab.url ?? ""))
    void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
  void captureContext(info, tab, ensureExecutor).catch(() => undefined);
}

function isContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): tab is chrome.tabs.Tab & { id: number; windowId: number } {
  return (
    typeof info.menuItemId === "string" &&
    isMenuAction(info.menuItemId) &&
    tab?.id !== undefined &&
    tab.windowId !== undefined &&
    tab.windowId >= 0 &&
    isSafePageUrl(info.pageUrl ?? tab.url ?? "") &&
    (info.menuItemId !== MENU_ASK_SELECTION || Boolean(info.selectionText?.trim()))
  );
}

function isMenuAction(action: string): boolean {
  return [MENU_ASK_SELECTION, MENU_SUMMARIZE, MENU_ADD_CONTEXT].includes(action);
}

async function captureContext(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab & { id: number; windowId: number },
  ensureExecutor: () => Promise<unknown>,
): Promise<void> {
  await ensureExecutor();
  const source = await sourceForTab(tab.id);
  const context = createContextRecord(info, tab, source?.target);
  if (!context) return;
  const handoff = createContextHandoff(String(info.menuItemId), tab.windowId, context);
  await chrome.storage.session.set({ [handoffKey(handoff.invocationId)]: handoff });
}

async function sourceForTab(tabId: number) {
  return (
    (await refreshInventoryTab(tabId)) ??
    currentInventoryTabs().find((candidate) => candidate.target.tabId === tabId)
  );
}

function createContextRecord(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab,
  target: BrowserTargetKey | undefined,
) {
  const capturedUrl = info.pageUrl ?? tab.url;
  if (!target || !capturedUrl || !isSafePageUrl(capturedUrl)) return undefined;
  const selection = info.selectionText?.trim();
  const result = PiBrowserContextRecordSchema.safeParse({
    contextId: crypto.randomUUID(),
    kind: selection ? "selection" : "page",
    capturedAt: new Date().toISOString(),
    target,
    url: capturedUrl,
    ...(tab.title ? { title: tab.title.slice(0, 512) } : {}),
    ...(selection
      ? {
          selectedText: selection.slice(0, 8000),
          ...(selection.length > 8000 ? { selectionTruncated: true } : {}),
        }
      : {}),
  });
  return result.success ? result.data : undefined;
}

function createContextHandoff(action: string, windowId: number, context: PiBrowserContextRecord) {
  const selection = context.selectedText;
  return BrowserContextHandoffSchema.parse({
    invocationId: crypto.randomUUID(),
    windowId,
    context,
    ...(action === MENU_SUMMARIZE
      ? { autoPrompt: selection ? "Summarize this selected text." : "Summarize this page." }
      : {}),
  });
}

function registerMenus(): void {
  void chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ASK_SELECTION,
      title: "Ask Aeon about selection",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: MENU_SUMMARIZE,
      title: "Summarize with Aeon",
      contexts: ["page", "selection"],
    });
    chrome.contextMenus.create({
      id: MENU_ADD_CONTEXT,
      title: "Add to Aeon Chat",
      contexts: ["page", "selection"],
    });
  });
}

function isSafePageUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

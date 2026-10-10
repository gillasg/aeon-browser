import { enableDiagnostics, forgetDiagnostics } from "./native-browser-diagnostics.js";
import { trackBrowserActivity, forgetBrowserActivity } from "./native-browser-settle.js";
import { releaseBrowserEvents } from "./native-browser-events.js";
import { persistBrowserOwners, restoreBrowserOwners } from "./native-browser-ownership.js";
import { ensureBrowserViewport, restoreBrowserViewport } from "./native-browser-viewport.js";
import { presentBrowserTask } from "./native-browser-layout.js";
interface Attachment {
  chatId: string;
  attached: Promise<void>;
  timer?: number;
}
const attachments = new Map<number, Attachment>();
const owners = new Map<number, string>();
const cancelled = new Map<number, string | undefined>();
const closing = new Map<number, Promise<void>>();

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  forget(source.tabId);
  if (reason === "canceled_by_user") cancelled.set(source.tabId, owners.get(source.tabId));
});
chrome.tabs.onRemoved.addListener((tabId) => {
  forget(tabId);
  owners.delete(tabId);
  cancelled.delete(tabId);
});

export function browserSessionOwner(tabId: number): string | undefined {
  return owners.get(tabId);
}

export function bindBrowserSession(tabId: number, chatId: string): void {
  if (owners.get(tabId) !== chatId && attachments.has(tabId)) throw new Error("CLAIM_CONFLICT");
  owners.set(tabId, chatId);
  persistBrowserOwners(owners);
}

export async function withBrowserDebugger<T>(
  tabId: number,
  action: (debuggee: chrome.debugger.Debuggee) => Promise<T>,
): Promise<T> {
  await closing.get(tabId);
  if (cancelled.has(tabId)) throw new Error("OPERATION_FAILED");
  const chatId = owners.get(tabId);
  if (!chatId) throw new Error("CLAIM_CONFLICT");
  let entry = attachments.get(tabId);
  if (!entry) {
    entry = { chatId, attached: attach(tabId) };
    attachments.set(tabId, entry);
  }
  try {
    await entry.attached;
    await presentBrowserTask(chatId, tabId);
    await ensureBrowserViewport(tabId);
    if (attachments.get(tabId) !== entry) throw new Error("OPERATION_FAILED");
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = globalThis.setTimeout(() => void detach(tabId), 90_000);
    void chrome.action.setBadgeText({ tabId, text: "AI" });
    void chrome.action.setBadgeBackgroundColor({ tabId, color: "#4299ff" });
    void chrome.action.setTitle({ tabId, title: "Aeon is controlling this tab · " + chatId });
    return await action({ tabId });
  } catch (error) {
    if (
      attachments.get(tabId) !== entry ||
      !(error instanceof Error) ||
      ![
        "STALE_REF",
        "AMBIGUOUS_TARGET",
        "TARGET_NOT_FOUND",
        "TARGET_HIDDEN",
        "TARGET_DISABLED",
        "TARGET_BLOCKED",
        "NOT_EDITABLE",
        "INPUT_FAILED",
        "INVALID_TARGET",
        "TIMEOUT",
      ].includes(error.message)
    )
      await detach(tabId);
    throw error;
  }
}

export async function releaseBrowserSessions(chatId?: string, reset = false): Promise<void> {
  releaseBrowserEvents(chatId);
  if (reset || !chatId)
    for (const [tabId, owner] of cancelled)
      if (!chatId || owner === chatId) cancelled.delete(tabId);
  const tabs = [...owners].filter(([, owner]) => !chatId || owner === chatId);
  for (const [tabId] of tabs) {
    owners.delete(tabId);
    if (reset || !chatId) cancelled.delete(tabId);
    await detach(tabId);
  }
  persistBrowserOwners(owners);
}

function forget(tabId: number): void {
  const entry = attachments.get(tabId);
  if (entry?.timer !== undefined) clearTimeout(entry.timer);
  attachments.delete(tabId);
  forgetDiagnostics(tabId);
  forgetBrowserActivity(tabId);
  void chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
  void chrome.action.setTitle({ tabId, title: "Open Aeon Chat" }).catch(() => undefined);
}

async function attach(tabId: number): Promise<void> {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    if (!/already attached/i.test(String(error))) throw error;
    // sendCommand succeeds only for our extension's attachment; do not take over DevTools.
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  }
  trackBrowserActivity(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  await Promise.all([
    chrome.debugger.sendCommand({ tabId }, "DOM.enable"),
    chrome.debugger.sendCommand({ tabId }, "Accessibility.enable"),
  ]);
  await chrome.debugger
    .sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true })
    .catch(() => undefined);
  await enableDiagnostics(tabId);
}

function detach(tabId: number): Promise<void> {
  const prior = closing.get(tabId);
  if (prior) return prior;
  const entry = attachments.get(tabId);
  forget(tabId);
  if (!entry) return Promise.resolve();
  const work = entry.attached
    .then(
      async () => {
        await restoreBrowserViewport(tabId);
        await chrome.debugger
          .sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: false })
          .catch(() => undefined);
        await chrome.debugger.detach({ tabId }).catch(() => undefined);
      },
      () => undefined,
    )
    .finally(() => {
      if (closing.get(tabId) === work) closing.delete(tabId);
    });
  closing.set(tabId, work);
  return work;
}
export async function reconnectBrowserSession(tabId: number): Promise<void> {
  await detach(tabId);
}
export async function restoreBrowserSessionOwners(): Promise<void> {
  await restoreBrowserOwners(owners);
}

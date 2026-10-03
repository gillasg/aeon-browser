import { enableDiagnostics, forgetDiagnostics } from "./native-browser-diagnostics.js";
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
    if (attachments.get(tabId) !== entry) throw new Error("OPERATION_FAILED");
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = globalThis.setTimeout(() => void detach(tabId), 90_000);
    void chrome.action.setBadgeText({ tabId, text: "AI" });
    void chrome.action.setBadgeBackgroundColor({ tabId, color: "#4299ff" });
    void chrome.action.setTitle({ tabId, title: "Aeon is controlling this tab · " + chatId });
    return await action({ tabId });
  } catch (error) {
    await detach(tabId);
    throw error;
  }
}

export async function releaseBrowserSessions(chatId?: string, reset = false): Promise<void> {
  if (reset || !chatId)
    for (const [tabId, owner] of cancelled)
      if (!chatId || owner === chatId) cancelled.delete(tabId);
  const tabs = [...owners].filter(([, owner]) => !chatId || owner === chatId);
  for (const [tabId] of tabs) {
    owners.delete(tabId);
    if (reset || !chatId) cancelled.delete(tabId);
    await detach(tabId);
  }
}

function forget(tabId: number): void {
  const entry = attachments.get(tabId);
  if (entry?.timer !== undefined) clearTimeout(entry.timer);
  attachments.delete(tabId);
  forgetDiagnostics(tabId);
  void chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
  void chrome.action.setTitle({ tabId, title: "Open Aeon Chat" }).catch(() => undefined);
}

async function attach(tabId: number): Promise<void> {
  await chrome.debugger.attach({ tabId }, "1.3");
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

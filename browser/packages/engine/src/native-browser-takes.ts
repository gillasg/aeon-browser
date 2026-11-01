// Takes: while the recordAgentTabs setting is on, every tab a chat drives is recorded from the
// moment the engine attaches to it, with nothing of ours drawn on it. A screen recorder
// switches the setting on for a run, then lists the recordings with browser.takes() and saves them
// with browser.saveTake(); with the run's trace they make a take it can edit. Keep it.
import { toOffscreen } from "./code-offscreen-host.js";
import { engineConfig } from "./engine-config.js";
import { startRecording, stopTake, takeTabs } from "./native-browser-recording.js";
import {
  browserSessionOwner,
  holdBrowserDebugger,
  onBrowserDebuggerAttached,
} from "./native-browser-session.js";
import { onEngineInstall } from "./native-engine-install.js";

const OFFSCREEN = "aeon-code-offscreen";
const SLICE = 750_000;
/** A take nobody saved is dropped this long after its tab closed or its recording stopped. */
const KEEP_MS = 30 * 60_000;

async function recordAgentTab(tabId: number): Promise<void> {
  void sweep();
  if (takeTabs.has(tabId)) return;
  const chatId = browserSessionOwner(tabId);
  if (!chatId || !(await engineConfig.recordAgentTabs().catch(() => false))) return;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const take = { chatId, url: tab?.url ?? "", startedAt: Date.now(), ...tabLook(tab) };
  takeTabs.set(tabId, take);
  // An idle detach would end the screencast mid-take: keep the debugger on while it records.
  holdBrowserDebugger(tabId, true);
  // With "Hide agent cursor" off, the take shows Aeon's own cursor and pill (never the glow).
  const shown = !(await engineConfig.hideAgentCursor().catch(() => true));
  await startRecording(tabId, { fps: 30, ...(shown ? { cursor: true, pill: true } : {}) }).catch(
    (error: unknown) => {
      takeTabs.set(tabId, {
        ...take,
        error: String(error instanceof Error ? error.message : error),
      });
    },
  );
}

/**
 * Records a chat's own tab (Aeon's chat page) as one of the chat's takes, so a screen recorder
 * gets the prompt being typed and the answer alongside the pages. Only while recordAgentTabs is on.
 */
export async function recordChatTab(tabId: number, chatId: string): Promise<boolean> {
  if (takeTabs.has(tabId) || !(await engineConfig.recordAgentTabs().catch(() => false)))
    return false;
  const take = { chatId, url: "chat", startedAt: Date.now(), chat: true };
  takeTabs.set(tabId, take);
  try {
    await startRecording(tabId, { fps: 30, direct: true });
    return true;
  } catch (error) {
    takeTabs.set(tabId, { ...take, error: String(error instanceof Error ? error.message : error) });
    return false;
  }
}

function tabLook(tab: chrome.tabs.Tab | undefined): { title?: string; favicon?: string } {
  return {
    ...(tab?.title ? { title: tab.title.slice(0, 200) } : {}),
    ...(tab?.favIconUrl && /^https?:/.test(tab.favIconUrl) ? { favicon: tab.favIconUrl } : {}),
  };
}

onEngineInstall(() => {
  // A take keeps its tab's latest title and favicon, for a recorder drawing the tab.
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    const take = takeTabs.get(tabId);
    if (take && !take.chat && (change.title || change.favIconUrl))
      Object.assign(take, tabLook(tab));
  });
  // Started after the attach finishes: the recording itself needs the debugger.
  onBrowserDebuggerAttached((tabId) => {
    setTimeout(() => void recordAgentTab(tabId), 0);
  });
});

async function dropTake(tabId: number): Promise<unknown> {
  takeTabs.delete(tabId);
  holdBrowserDebugger(tabId, false);
  return toOffscreen({ target: OFFSCREEN, kind: "recordDrop", tabId });
}

/** Drops takes that stopped long ago, and stops the ones still running once the setting is off. */
async function sweep(): Promise<void> {
  const on = await engineConfig.recordAgentTabs().catch(() => false);
  for (const [tabId, take] of takeTabs) {
    if (!on && !take.stopped && !take.error) await stopTake(tabId);
    const ended = take.endedAt ?? (take.stopped || take.error ? Date.now() : undefined);
    if (ended !== undefined) take.endedAt = ended;
    if (ended !== undefined && Date.now() - ended > KEEP_MS)
      await dropTake(tabId).catch(() => undefined);
  }
}

export async function takesCall(value: Record<string, unknown>): Promise<unknown> {
  await sweep();
  const tabId = Number(value.tabId);
  if (value.takes === "list") {
    const chatId = typeof value.chatId === "string" ? value.chatId : undefined;
    return (
      [...takeTabs]
        // A tab another chat adopted mid-recording belongs to both.
        .filter(
          ([id, take]) => !chatId || take.chatId === chatId || browserSessionOwner(id) === chatId,
        )
        .map(([id, take]) => ({ tabId: id, ...take, recording: !take.stopped && !take.error }))
    );
  }
  if (!takeTabs.has(tabId)) throw new Error("INVALID_INPUT: no take for that tab");
  if (value.takes === "stop") return stopTake(tabId);
  if (value.takes === "read")
    return toOffscreen({
      target: OFFSCREEN,
      kind: "recordRead",
      tabId,
      offset: Number(value.offset) || 0,
      size: SLICE,
    });
  if (value.takes === "drop") return dropTake(tabId);
  throw new Error("INVALID_INPUT: takes is list, stop, read or drop");
}

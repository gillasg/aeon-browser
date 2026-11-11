import { send } from "./cdp/send.js";
import { engineConfig } from "./engine-config.js";
import { withLock } from "./native-browser-scheduler.js";
import { guardAgentTab } from "./native-browser-tab-cleanup.js";
import { withBrowserDebugger } from "./native-browser-session.js";
import { onEngineInstall } from "./native-engine-install.js";
import { handoffActive } from "./native-browser-control.js";
import { noteUserLogin } from "./native-browser-vault.js";
import {
  agentNeedsExpression,
  showAgentBadge,
  showAgentNeeds,
  tabRecording,
} from "./native-browser-cursor.js";

// Hand-off: the agent pauses and asks the user to do something in the real tab (sign in, 2FA,
// pick an option). The cursor turns amber, points at the element when one is given, and its pill
// carries the request with Done and Cancel; the cell waits until one is clicked. Login flows
// navigate, so the pill is shown again on each new document. A system notification is sent only
// when the user cannot see the tab (its window is not in front, or the tab is being recorded,
// when the page shows nothing of ours); the chat's card carries it too.
const POLL_MS = 600;
const MAX_WAIT_MS = 30 * 60_000;
const KEY = "Symbol.for('aeon.handoff')";

/**
 * The hand-off's state in the page: Done or Cancel in the cursor's pill sets it, and so does an
 * answer typed into the pill instead ({answer}). "fresh" means a new document (the site
 * navigated), so the pill is shown again.
 */
const STATE = `(() => {
  const state = globalThis[${KEY}];
  if (state === "done" || state === "cancelled") return state;
  if (state && typeof state === "object" && typeof state.answer === "string") return { answer: state.answer };
  if (!state) { globalThis[${KEY}] = "waiting"; return "fresh"; }
  return "waiting";
})()`;

// Answers given from the chat's hand-off card, keyed by tab; the next poll picks them up.
const answers = new Map<number, "done" | "cancelled">();
onEngineInstall(() => {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || message?.kind !== "aeon.handoff.answer") return;
    if (message.answer === "done" || message.answer === "cancelled")
      answers.set(Number(message.tabId), message.answer);
  });
});

const CLEAR = `(() => { delete globalThis[${KEY}]; })()`;

// Done and Cancel live on the page. Reading them through the debugger misses the answer when that
// tab's debugger call is stuck, or when another debugger (DevTools, a test) is attached: the poll
// then reports "waiting" forever and the hand-off never appears. The main world is the same one
// the page's button writes.
function handoffPageState(): unknown {
  const key = Symbol.for("aeon.handoff");
  const state = (globalThis as Record<symbol, unknown>)[key];
  if (state === "done" || state === "cancelled") return state;
  if (
    state &&
    typeof state === "object" &&
    typeof (state as { answer?: unknown }).answer === "string"
  )
    return { answer: (state as { answer: string }).answer };
  if (!state) {
    (globalThis as Record<symbol, unknown>)[key] = "waiting";
    return "fresh";
  }
  return "waiting";
}

function clearHandoffPageState(): void {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("aeon.handoff")];
}

function knownHandoffState(state: unknown): boolean {
  if (state === "done" || state === "cancelled" || state === "fresh" || state === "waiting")
    return true;
  return Boolean(
    state &&
    typeof state === "object" &&
    typeof (state as { answer?: unknown }).answer === "string",
  );
}

async function pageHandoffState(tabId: number): Promise<unknown> {
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: handoffPageState,
    });
    const state = injected?.result;
    if (knownHandoffState(state)) return state;
  } catch {
    // A page scripting cannot reach still answers through the debugger.
  }
  return evaluate(tabId, STATE);
}

// What the user typed into the cursor's ask instead of acting in the tab, kept for the hand-off's
// caller (bu.handoff returns it) until it is taken.
const typed = new Map<number, string>();
export function takeTypedAnswer(tabId: number): string | undefined {
  const answer = typed.get(tabId);
  typed.delete(tabId);
  return answer;
}

/** Whether the user can see the tab now: active in a focused window, and not being recorded. */
async function userSees(tabId: number, windowId: number): Promise<boolean> {
  if (tabRecording(tabId)) return false;
  const window = await chrome.windows.get(windowId).catch(() => undefined);
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  return Boolean(window?.focused && window.state !== "minimized" && tab?.active);
}

export async function handOffToUser(
  tabId: number,
  message: string,
  active: () => boolean,
  spotlight?: { x: number; y: number; width: number; height: number },
): Promise<"done" | "cancelled"> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) throw new Error("TARGET_LOST");
  await withLock(`window:${tab.windowId}`, async () => {
    await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  });
  const notification = "aeon-handoff-" + tabId;
  if (!(await userSees(tabId, tab.windowId)))
    void chrome.notifications
      .create(notification, {
        type: "basic",
        iconUrl: chrome.runtime.getURL(engineConfig.notificationIcon),
        title: "The agent needs you",
        message,
        requireInteraction: true,
      })
      .catch(() => undefined);
  const deadline = Date.now() + MAX_WAIT_MS;
  answers.delete(tabId);
  typed.delete(tabId);
  guardAgentTab(tabId, true);
  handoffActive(tabId, true);
  showAgentNeeds(tabId, message, spotlight);
  try {
    while (active() && Date.now() < deadline) {
      if (!(await chrome.tabs.get(tabId).catch(() => undefined))) throw new Error("TARGET_LOST");
      const answered = answers.get(tabId);
      if (answered) return answered;
      // A password the user types here is kept (never shown to the agent) so it can be saved.
      await noteUserLogin(tabId);
      const state = tabRecording(tabId) ? "waiting" : await pageHandoffState(tabId);
      if (state === "done" || state === "cancelled") return state;
      if (typeof (state as { answer?: unknown } | null)?.answer === "string") {
        typed.set(tabId, (state as { answer: string }).answer);
        return "done";
      }
      if (state === "fresh") {
        void showAgentBadge(tabId, true);
        await evaluate(tabId, agentNeedsExpression(message, spotlight)).catch(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return "cancelled";
  } finally {
    guardAgentTab(tabId, false);
    handoffActive(tabId, false);
    showAgentNeeds(tabId, null);
    answers.delete(tabId);
    void chrome.notifications.clear(notification).catch(() => undefined);
    void chrome.scripting
      .executeScript({ target: { tabId }, world: "MAIN", func: clearHandoffPageState })
      .catch(() => undefined);
    void evaluate(tabId, CLEAR).catch(() => undefined);
  }
}

onEngineInstall(() => {
  chrome.notifications.onClicked.addListener((id) => {
    if (!id.startsWith("aeon-handoff-")) return;
    const tabId = Number(id.slice("aeon-handoff-".length));
    void chrome.tabs.get(tabId).then(
      (tab) =>
        Promise.all([
          chrome.tabs.update(tabId, { active: true }),
          chrome.windows.update(tab.windowId, { focused: true }),
        ]),
      () => undefined,
    );
  });
});

async function evaluate(tabId: number, expression: string): Promise<unknown> {
  // A page mid-navigation has no context to evaluate in; that poll just reports "waiting".
  const result = await withBrowserDebugger(tabId, (debuggee) =>
    send(
      debuggee,
      "Runtime.evaluate",
      { expression, returnByValue: true, silent: true },
      { label: "evaluate", ms: 5_000 },
    ),
  ).catch(() => undefined);
  return (result as { result?: { value?: unknown } } | undefined)?.result?.value ?? "waiting";
}

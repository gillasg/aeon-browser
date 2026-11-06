import { engineConfig } from "./engine-config.js";
import { guardAgentTab } from "./native-browser-tab-cleanup.js";
import { withBrowserDebugger } from "./native-browser-session.js";
import { onEngineInstall } from "./native-engine-install.js";
import { handoffActive } from "./native-browser-control.js";
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
 * The hand-off's state in the page: Done or Cancel in the cursor's pill sets it. "fresh" means a
 * new document (the site navigated), so the pill is shown again.
 */
const STATE = `(() => {
  const state = globalThis[${KEY}];
  if (state === "done" || state === "cancelled") return state;
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
  await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
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
  guardAgentTab(tabId, true);
  handoffActive(tabId, true);
  showAgentNeeds(tabId, message, spotlight);
  try {
    while (active() && Date.now() < deadline) {
      if (!(await chrome.tabs.get(tabId).catch(() => undefined))) throw new Error("TARGET_LOST");
      const answered = answers.get(tabId);
      if (answered) return answered;
      const state = tabRecording(tabId) ? "waiting" : await evaluate(tabId, STATE);
      if (state === "done" || state === "cancelled") return state;
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
    chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      silent: true,
    }),
  ).catch(() => undefined);
  return (result as { result?: { value?: unknown } } | undefined)?.result?.value ?? "waiting";
}

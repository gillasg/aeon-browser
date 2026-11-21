import type { HandoffMeta } from "@browserkit/protocol";
import { engineConfig } from "./engine-config.js";
import { engineDebug } from "./native-debug-log.js";
import { withLock } from "./native-browser-scheduler.js";
import { guardAgentTab } from "./native-browser-tab-cleanup.js";
import { onEngineInstall } from "./native-engine-install.js";
import { handoffActive } from "./native-browser-control.js";
import { noteUserLogin } from "./native-browser-vault.js";
import { hideHandoffAsk, showHandoffAsk } from "./native-browser-ask.js";
import { showAgentBadge, showAgentNeeds, tabRecording } from "./native-browser-cursor.js";

// Hand-off: the agent pauses and asks the user to do something in the real tab (sign in, 2FA,
// pick an option). The cursor turns amber, points at the element when one is given, and its pill
// carries the request with Done and Cancel; the cell waits until one is clicked. Login flows
// navigate, so the pill and the ask are shown again on each new document. The typed answer lives
// in the isolated world (native-browser-ask.ts), never where the page can read or forge it. A
// system notification is sent only when the user cannot see the tab (its window is not in front,
// or the tab is being recorded, when the page shows nothing of ours); the chat's card carries it.
const POLL_MS = 600;
const MAX_WAIT_MS = 30 * 60_000;

// Answers given from the chat's hand-off card or from the cursor's ask, keyed by tab; the next
// poll picks them up.
const answers = new Map<number, "done" | "cancelled">();
onEngineInstall(() => {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || message?.kind !== "aeon.handoff.answer") return;
    // The ask includes its tab; the chat's hand-off card names the target too. Only fall back to
    // the sender's tab when the message carries none (a card in a chat tab must not answer for
    // the chat tab itself).
    const tabId = Number.isSafeInteger(message.tabId) ? message.tabId : sender.tab?.id;
    if (tabId === undefined) return;
    if (message.answer === "done" || message.answer === "cancelled")
      answers.set(tabId, message.answer);
    else if (message.answer && typeof message.answer.answer === "string") {
      typed.set(tabId, message.answer.answer.slice(0, 2000));
      answers.set(tabId, "done");
    }
  });
});

// What the user typed into the cursor's ask instead of acting in the tab, kept for the hand-off's
// caller (bu.handoff returns it) until it is taken.
const typed = new Map<number, string>();
function takeTypedAnswer(tabId: number): string | undefined {
  const answer = typed.get(tabId);
  typed.delete(tabId);
  return answer;
}

/** A hand-off the user answered by typing into the cursor returns that text. */
export function answeredHandoff(
  tabId: number,
  outcome: "done" | "cancelled",
): "done" | "cancelled" | { answer: string } {
  const answer = outcome === "done" ? takeTypedAnswer(tabId) : undefined;
  return answer !== undefined ? { answer } : outcome;
}

/** Whether the user can see the tab now: active in a focused window, and not being recorded. */
async function userSees(tabId: number, windowId: number): Promise<boolean> {
  if (tabRecording(tabId)) return false;
  const window = await chrome.windows.get(windowId).catch(() => undefined);
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  return Boolean(window?.focused && window.state !== "minimized" && tab?.active);
}

/** Keep the request and its ask up across a login flow's navigations. */
function followNavigation(
  tabId: number,
  message: string,
  spotlight?: { x: number; y: number; width: number; height: number },
  meta: HandoffMeta = {},
): (details: { tabId: number; frameId: number }) => void {
  const point = spotlight
    ? {
        x: Math.round(spotlight.x + spotlight.width / 2),
        y: Math.round(spotlight.y + spotlight.height / 2),
      }
    : undefined;
  return (details) => {
    if (details.tabId !== tabId || details.frameId !== 0) return;
    showAgentNeeds(tabId, message, spotlight, meta);
    void showHandoffAsk(tabId, point, meta);
  };
}

export async function handOffToUser(
  tabId: number,
  message: string,
  active: () => boolean,
  spotlight?: { x: number; y: number; width: number; height: number },
  meta: HandoffMeta = {},
): Promise<"done" | "cancelled"> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) throw new Error("TARGET_LOST");
  engineDebug("handoff", "start", { tab: tabId, window: tab.windowId });
  await withLock(`window:${tab.windowId}`, async () => {
    await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  });
  engineDebug("handoff", "focused", { tab: tabId });
  const notification = "aeon-handoff-" + tabId;
  const seen = await userSees(tabId, tab.windowId);
  engineDebug("handoff", "visibility", { tab: tabId, seen });
  if (!seen)
    void chrome.notifications
      .create(notification, {
        type: "basic",
        iconUrl: chrome.runtime.getURL(engineConfig.notificationIcon),
        title: meta.kind === "cliff-edge" ? "Your go-ahead is needed" : "The agent needs you",
        message,
        requireInteraction: true,
      })
      .catch(() => undefined);
  const deadline = Date.now() + MAX_WAIT_MS;
  answers.delete(tabId);
  typed.delete(tabId);
  guardAgentTab(tabId, true);
  handoffActive(tabId, true);
  showAgentNeeds(tabId, message, spotlight, meta);
  const follow = followNavigation(tabId, message, spotlight, meta);
  chrome.webNavigation.onCommitted.addListener(follow);
  void showHandoffAsk(
    tabId,
    spotlight
      ? {
          x: Math.round(spotlight.x + spotlight.width / 2),
          y: Math.round(spotlight.y + spotlight.height / 2),
        }
      : undefined,
    meta,
  );
  engineDebug("handoff", "shown", { tab: tabId });
  const startedAt = Date.now();
  try {
    while (active() && Date.now() < deadline) {
      const answered = answers.get(tabId);
      if (answered) return answered;
      if (!(await chrome.tabs.get(tabId).catch(() => undefined))) throw new Error("TARGET_LOST");
      // A password the user types here is kept (never shown to the agent) so it can be saved.
      await noteUserLogin(tabId);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return "cancelled";
  } finally {
    chrome.webNavigation.onCommitted.removeListener(follow);
    engineDebug("handoff", "end", { tab: tabId, ms: Date.now() - startedAt });
    guardAgentTab(tabId, false);
    handoffActive(tabId, false);
    void hideHandoffAsk(tabId);
    showAgentNeeds(tabId, null);
    answers.delete(tabId);
    void chrome.notifications.clear(notification).catch(() => undefined);
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

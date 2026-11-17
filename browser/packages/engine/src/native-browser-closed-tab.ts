import type {
  BrowserExecutorRequest,
  BrowserExecutorResult,
  BrowserStep,
} from "@browserkit/protocol";
import { takeWriteWait } from "./native-browser-scheduler.js";

/**
 * A click or key press that makes the page close its own tab (a "Continue with Google" pop-up
 * finishing) did its job: report it as a change pointing at the opener, never as TARGET_LOST.
 */
export async function closedByAction(
  request: BrowserExecutorRequest,
  step: BrowserStep,
  tab: chrome.tabs.Tab,
  error: unknown,
): Promise<BrowserExecutorResult> {
  if (!closingSteps.has(step.op) || !("target" in step)) throw error;
  // A renderer destroyed by window.close() mid-click need not answer Input.dispatchMouseEvent at
  // all, so CDP reports TAB_UNRESPONSIVE after the input limit instead of a detach. The tab-gone
  // check below is what makes that safe to call a self-close, whatever the transport called it.
  const lateInput =
    /TAB_UNRESPONSIVE/.test(String(error)) &&
    (error as { mayHaveLateEffects?: boolean })?.mayHaveLateEffects === true;
  if (!lateInput && !/TARGET_LOST|TAB_DEAD|detached|No tab with id/i.test(String(error)))
    throw error;
  if (await tabStillOpen(step.target.tabId, lateInput)) throw error;
  const opener = tab.openerTabId;
  return {
    kind: "action",
    target: step.target,
    documentEpoch: request.expectedDocumentEpoch ?? 0,
    url: tab.url ?? "",
    outcome: "changed",
    effect: "confirmed",
    evidence: "the page closed this tab itself after the action",
    note:
      "The page closed this tab itself after the action (a pop-up such as a sign-in window finishing); the action worked." +
      (opener !== undefined
        ? ` Carry on in tab ${opener}, which opened it.`
        : " browser.tabs() lists the open tabs."),
  };
}
const closingSteps = new Set<string>(["click", "press", "fill", "paste"]);

/**
 * window.close() can destroy the renderer before the input CDP answer, and the tab can still be
 * listed for a moment after that answer times out. Give a late input a brief window to disappear;
 * a tab that stays open keeps its original error. Never wait on the ordinary detach path.
 */
async function tabStillOpen(tabId: number, lateInput: boolean): Promise<boolean> {
  const gone = () =>
    chrome.tabs.get(tabId).then(
      (tab) => !tab,
      () => true,
    );
  if (await gone()) return false;
  if (!lateInput) return true;
  for (let waited = 0; waited < 1000; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await gone()) return false;
  }
  return true;
}

/** A write that queued behind another session's says how long, so slow steps explain themselves. */
export function withWaitNote(result: BrowserExecutorResult, tabId: number): BrowserExecutorResult {
  const waited = takeWriteWait(tabId);
  if (waited === undefined || result.kind !== "action") return result;
  const note = `waited ${(waited / 1000).toFixed(1)} s for another session's action in this browser`;
  return { ...result, note: (result.note ? `${result.note} (${note})` : note).slice(0, 1000) };
}

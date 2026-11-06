import type {
  BrowserExecutorRequest,
  BrowserExecutorResult,
  BrowserStep,
} from "@browserkit/protocol";

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
  if (!/TARGET_LOST|TAB_DEAD|detached|No tab with id/i.test(String(error))) throw error;
  if (await chrome.tabs.get(step.target.tabId).then(Boolean, () => false)) throw error;
  const opener = tab.openerTabId;
  return {
    kind: "action",
    target: step.target,
    documentEpoch: request.expectedDocumentEpoch ?? 0,
    url: tab.url ?? "",
    outcome: "changed",
    note:
      "The page closed this tab itself after the action (a pop-up such as a sign-in window finishing); the action worked." +
      (opener !== undefined
        ? ` Carry on in tab ${opener}, which opened it.`
        : " browser.tabs() lists the open tabs."),
  };
}
const closingSteps = new Set<string>(["click", "press", "fill", "paste"]);

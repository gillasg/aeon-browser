import { BrowserActionError } from "./native-browser-common.js";

// Another extension's popup on top of a tab, or another debugger already holding it, makes
// chrome.debugger.attach fail on renew. That tab is still the agent's: it is marked and the next
// step tries again, instead of dropping it from the agent's set.

const BLOCKED =
  /Cannot access a chrome-extension:\/\/ URL of different extension|Another debugger is already attached/i;

export const BLOCKED_NOTE = "blocked by another extension";

const blocked = new Map<number, string>();

/** True for an attach failure caused by another extension, which clears up on its own. */
export function blockedByExtension(error: unknown): boolean {
  return BLOCKED.test(String(error instanceof Error ? error.message : error));
}

/** Why the debugger is off this tab right now, for the tab list. */
export function debuggerBlocked(tabId: number): string | undefined {
  return blocked.get(tabId);
}

export function forgetDebuggerBlock(tabId: number): void {
  blocked.delete(tabId);
}

/**
 * Runs an attach. A block by another extension marks the tab and fails this step with a
 * retryable DEBUGGER_DETACHED; the tab stays owned and the next step (or tabs.onUpdated) retries.
 */
export async function renewAttach(tabId: number, attach: () => Promise<unknown>): Promise<void> {
  try {
    await attach();
    blocked.delete(tabId);
  } catch (error) {
    if (!blockedByExtension(error)) throw error;
    blocked.set(tabId, BLOCKED_NOTE);
    throw new BrowserActionError(
      "DEBUGGER_DETACHED",
      `Tab ${tabId} is ${BLOCKED_NOTE} (a popup or debugger is on top); it stays yours and the next step retries.`,
    );
  }
}

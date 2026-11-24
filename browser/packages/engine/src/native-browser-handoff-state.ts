import type { HandoffStatus } from "@browserkit/protocol";

// Pending hand-offs by tab, so the tab list, `aeon tabs`, `aeon status` and the cursor box can
// all say "Waiting on you: <msg>". No Chrome calls here: readers import it without side effects.

const pending = new Map<number, HandoffStatus>();

export function beginHandoff(
  tabId: number,
  message: string,
  startedAt = Date.now(),
): HandoffStatus {
  const status = { message: message.slice(0, 2000), startedAt };
  pending.set(tabId, status);
  return status;
}

export function endHandoff(tabId: number): void {
  pending.delete(tabId);
}

/** The pending hand-off in this tab, if the agent is waiting on the user there. */
export function handoffFor(tabId: number): HandoffStatus | undefined {
  return pending.get(tabId);
}

/** Every pending hand-off, for status lines. */
export function pendingHandoffs(): Array<{ tabId: number } & HandoffStatus> {
  return [...pending].map(([tabId, status]) => ({ tabId, ...status }));
}

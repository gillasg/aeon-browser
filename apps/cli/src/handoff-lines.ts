import { clipHandoffMessage, elapsedLabel } from "@aeon/protocol";

/** A tab row as `aeon tabs` and `aeon status` read it. */
export interface HandoffTab {
  target?: { tabId?: number };
  title?: string;
  handoff?: { message: string; startedAt: number };
}

/** "  waiting on you: <msg> · 2m 10s", printed under a tab row while a hand-off is pending. */
export function handoffLine(
  handoff: { message: string; startedAt: number },
  now = Date.now(),
): string {
  return `  waiting on you: ${clipHandoffMessage(handoff.message)} · ${elapsedLabel(now - handoff.startedAt)}`;
}

/** One line per pending hand-off, naming its tab, for `aeon status`. */
export function statusHandoffLines(tabs: HandoffTab[], now = Date.now()): string[] {
  return tabs.flatMap((tab) =>
    tab.handoff
      ? [
          `Tab ${tab.target?.tabId ?? "?"} ${tab.title ?? ""}`.trimEnd() +
            "\n" +
            handoffLine(tab.handoff, now),
        ]
      : [],
  );
}

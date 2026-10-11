import { useEffect, useState, type ReactElement } from "react";
import type { TranscriptRow } from "./transcript-model.js";

// A browser hand-off in progress: the agent's code cell is waiting for the user to act in a tab.
// The page shows its own banner; this card is the chat-side copy of the same request.
export interface PendingHandoff {
  toolCallId: string;
  message: string;
  tabId: number;
}

export type HandoffAction = "focus" | "done" | "cancelled";
/** Hosts listen for this window event and carry the answer to the browser. */
export const HANDOFF_EVENT = "aeon:handoff";

export function pendingHandoff(rows: readonly TranscriptRow[]): PendingHandoff | null {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (row?.kind !== "tool-group") continue;
    for (const step of [...row.group.steps].reverse()) {
      if (step.state !== "running") continue;
      const found = runningHandoff(step.partialResult);
      if (found) return { toolCallId: step.toolCallId, ...found };
    }
  }
  return null;
}

function runningHandoff(partial: string): { message: string; tabId: number } | null {
  try {
    const parsed = JSON.parse(partial) as { steps?: unknown };
    if (!Array.isArray(parsed.steps)) return null;
    const last = [...parsed.steps]
      .reverse()
      .find(
        (item): item is { action: Record<string, unknown>; disposition: unknown } =>
          typeof item === "object" && item !== null && "action" in item,
      );
    const action = last?.action;
    if (!action || action.op !== "handoff" || last.disposition !== "running") return null;
    const target = action.target as { tabId?: unknown } | undefined;
    if (typeof target?.tabId !== "number") return null;
    return { message: String(action.message ?? ""), tabId: target.tabId };
  } catch {
    return null;
  }
}

export function HandoffCard({ handoff }: { handoff: PendingHandoff }): ReactElement {
  const [answered, setAnswered] = useState(false);
  useEffect(() => setAnswered(false), [handoff.toolCallId, handoff.message]);
  const send = (action: HandoffAction) => {
    if (action !== "focus") setAnswered(true);
    window.dispatchEvent(
      new CustomEvent(HANDOFF_EVENT, { detail: { tabId: handoff.tabId, action } }),
    );
  };
  return (
    <section className="handoff-card" role="status" aria-label="The agent needs you">
      <header>
        <span>Browser</span>
        <span className="handoff-badge">Action needed</span>
      </header>
      <p>{handoff.message}</p>
      <div className="handoff-actions">
        <button type="button" className="handoff-primary" onClick={() => send("focus")}>
          Take over
        </button>
        <button type="button" disabled={answered} onClick={() => send("done")}>
          I&apos;m done
        </button>
        <button
          type="button"
          className="handoff-skip"
          disabled={answered}
          onClick={() => send("cancelled")}
        >
          Skip
        </button>
      </div>
    </section>
  );
}

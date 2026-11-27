import { useEffect, useState, type ReactElement } from "react";
import type { TranscriptRow } from "./transcript-model.js";

// A browser hand-off in progress: the agent's code cell is waiting for the user to act in a tab.
// One owner per state: while the panel shows this card, the page shows only its ring.
export interface PendingHandoff {
  toolCallId: string;
  message: string;
  tabId: number;
}

export type HandoffAction = "focus" | "done" | "cancelled";
/** Hosts listen for this window event and carry the answer to the browser. */
export const HANDOFF_EVENT = "graft:handoff";

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

/**
 * The one place the panel asks for the user's hand: a neutral card, the agent's message, `I'm
 * done` (the only ochre on the panel) and a quiet Skip. No badge, no stripe, no coloured border.
 */
export function HandoffCard({ handoff }: { handoff: PendingHandoff }): ReactElement {
  const [answered, setAnswered] = useState(false);
  useEffect(() => setAnswered(false), [handoff.toolCallId, handoff.message]);
  const send = (action: HandoffAction) => {
    setAnswered(true);
    window.dispatchEvent(
      new CustomEvent(HANDOFF_EVENT, { detail: { tabId: handoff.tabId, action } }),
    );
  };
  return (
    <section className="handoff-card" role="status" aria-label="Graft needs you">
      <p>{handoff.message || "Graft needs you in this tab."}</p>
      <div className="handoff-actions">
        <button
          type="button"
          className="handoff-done"
          disabled={answered}
          onClick={() => send("done")}
        >
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

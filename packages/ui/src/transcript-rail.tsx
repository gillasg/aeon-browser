import { useState, type CSSProperties, type ReactElement, type RefObject } from "react";
import type { TranscriptRow } from "./transcript-model.js";
import { transcriptTurns } from "./transcript-turn.js";

interface RailTurn {
  entryId: string;
  user: string;
  assistant: string;
}

/**
 * The message rail on the left of the transcript: one notch per user message. Hovering a notch
 * shows the user's prompt and the assistant answer it led to; clicking jumps to that turn.
 */
export function TranscriptRail({
  rows,
  root,
}: {
  rows: readonly TranscriptRow[];
  root: RefObject<HTMLElement | null>;
}): ReactElement | null {
  const turns = railTurns(rows);
  const [active, setActive] = useState<number | null>(null);
  if (turns.length < 2) return null;
  return (
    <nav className="transcript-rail" aria-label="Message history">
      {turns.map((turn, index) => {
        const top = (index / (turns.length - 1)) * 100;
        return (
          <button
            key={turn.entryId}
            type="button"
            className="transcript-rail-tick"
            style={{ "--rail-top": `${top}%` } as CSSProperties}
            data-active={active === index ? "true" : undefined}
            aria-label={`Message ${index + 1} of ${turns.length}: ${turn.user}`}
            onMouseEnter={() => setActive(index)}
            onMouseLeave={() => setActive((current) => (current === index ? null : current))}
            onFocus={() => setActive(index)}
            onBlur={() => setActive((current) => (current === index ? null : current))}
            onClick={() => scrollTo(root.current, turn.entryId)}
          />
        );
      })}
      {active !== null && (
        <div
          className="transcript-rail-preview"
          role="tooltip"
          style={{ "--rail-top": `${(active / (turns.length - 1)) * 100}%` } as CSSProperties}
        >
          <strong>{turns[active]?.user}</strong>
          {turns[active]?.assistant && <span>{turns[active]?.assistant}</span>}
        </div>
      )}
    </nav>
  );
}

function scrollTo(root: HTMLElement | null, entryId: string): void {
  const escaped = typeof CSS === "undefined" ? entryId : CSS.escape(entryId);
  root?.querySelector<HTMLElement>(`[data-pi-entry-id="${escaped}"]`)?.scrollIntoView({
    block: "start",
    behavior: "smooth",
  });
}

function railTurns(rows: readonly TranscriptRow[]): RailTurn[] {
  const turns: RailTurn[] = [];
  for (const turn of transcriptTurns(rows)) {
    const user = turn.find((row) => row.kind === "entry" && row.entry.message?.role === "user");
    if (!user || user.kind !== "entry") continue;
    const assistant = [...turn]
      .reverse()
      .map((row) => messageText(row))
      .find((text) => Boolean(text));
    turns.push({
      entryId: user.entry.entryId,
      user: preview(messageText(user), 110),
      assistant: preview(assistant ?? "", 150),
    });
  }
  return turns;
}

function messageText(row: TranscriptRow): string {
  if (row.kind === "tool-group") return "";
  const message = row.kind === "transient" ? row.message : row.entry.message;
  if (!message) return "";
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function preview(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

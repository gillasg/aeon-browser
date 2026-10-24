import { useEffect, useState, type CSSProperties, type ReactElement, type RefObject } from "react";
import type { TranscriptRow } from "./transcript-model.js";
import { transcriptTurns } from "./transcript-turn.js";

interface RailTurn {
  entryId: string;
  user: string;
  assistant: string;
}

/**
 * The message rail on the left of the transcript: one notch per user message, stacked at an even
 * pitch. The notch under the pointer is longest and its neighbours step down; the turn in view
 * is lit. Hovering shows the user's prompt and the answer it led to; clicking jumps to it.
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
  const current = useTurnInView(root, turns.map((turn) => turn.entryId).join(" "));
  if (turns.length < 2) return null;
  return (
    <nav className="transcript-rail" aria-label="Message history">
      {turns.map((turn, index) => {
        const near = active === null ? undefined : Math.abs(active - index);
        return (
          <button
            key={turn.entryId}
            type="button"
            className="transcript-rail-tick"
            data-active={near === 0 ? "true" : undefined}
            data-near={near !== undefined && near > 0 && near < 3 ? String(near) : undefined}
            data-current={current === index ? "true" : undefined}
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
          style={{ "--rail-index": active, "--rail-count": turns.length } as CSSProperties}
        >
          <strong>{turns[active]?.user}</strong>
          {turns[active]?.assistant && <span>{turns[active]?.assistant}</span>}
        </div>
      )}
    </nav>
  );
}

/** The last turn whose prompt has scrolled to or above the middle of the transcript. */
function useTurnInView(root: RefObject<HTMLElement | null>, ids: string): number {
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const update = (): void => {
      const middle = element.getBoundingClientRect().top + element.clientHeight / 2;
      let found = 0;
      ids.split(" ").forEach((id, index) => {
        const escaped = typeof CSS === "undefined" ? id : CSS.escape(id);
        const row = element.querySelector(`[data-pi-entry-id="${escaped}"]`);
        if (row && row.getBoundingClientRect().top <= middle) found = index;
      });
      setCurrent(found);
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    return () => element.removeEventListener("scroll", update);
  }, [root, ids]);
  return current;
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

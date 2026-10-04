import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { PendingWork } from "./pending-work.js";
import { AnnotationSelection } from "./annotation-selection.js";
import type { TranscriptRow } from "./transcript-model.js";
import { TranscriptTurn, transcriptTurns } from "./transcript-turn.js";

export function ChatTranscript({
  rows,
  onEditEntry,
  onBranchEntry,
  actionsDisabled = false,
  running = false,
  starting = false,
}: {
  rows: readonly TranscriptRow[];
  onEditEntry?: (entryId: string) => Promise<void> | void;
  onBranchEntry?: (entryId: string) => Promise<void> | void;
  actionsDisabled?: boolean;
  running?: boolean;
  starting?: boolean;
}): ReactElement {
  const { root, awayFromLatest, atTop, updateScrollState, jumpToLatest } =
    useTranscriptScroll(rows);
  return (
    <div
      className="transcript-wrap"
      data-at-top={String(atTop)}
      data-at-bottom={String(!awayFromLatest)}
    >
      <section
        ref={root}
        className="transcript"
        aria-label="Chat conversation"
        aria-live="polite"
        onScroll={updateScrollState}
      >
        {transcriptTurns(rows).map((turn) => (
          <TranscriptTurn
            key={turn[0]?.key}
            rows={turn}
            actions={{
              actionsDisabled,
              ...(onEditEntry ? { onEditEntry } : {}),
              ...(onBranchEntry ? { onBranchEntry } : {}),
            }}
          />
        ))}
        {(starting || running) && !latestWorkVisible(rows, starting) && <PendingWork />}
      </section>
      <AnnotationSelection root={root} />
      {awayFromLatest && <JumpToLatest onClick={jumpToLatest} />}
    </div>
  );
}

function JumpToLatest({ onClick }: { onClick(): void }): ReactElement {
  return (
    <button className="transcript-jump-latest" type="button" onClick={onClick}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 4v11m0 0-4.3-4.3M10 15l4.3-4.3" />
      </svg>
      Latest
    </button>
  );
}

function useTranscriptScroll(rows: readonly TranscriptRow[]) {
  const root = useRef<HTMLElement>(null);
  const followTail = useRef(true);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [atTop, setAtTop] = useState(true);
  const updateScrollState = useCallback((): void => {
    const node = root.current;
    if (!node) return;
    const distanceFromBottom = node.scrollHeight - node.clientHeight - node.scrollTop;
    const isAtBottom = distanceFromBottom <= 36;
    followTail.current = isAtBottom;
    setAwayFromLatest(!isAtBottom);
    setAtTop(node.scrollTop <= 3);
  }, []);

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    if (followTail.current) node.scrollTop = node.scrollHeight;
    const frame = window.requestAnimationFrame(updateScrollState);
    return () => window.cancelAnimationFrame(frame);
  }, [rows, updateScrollState]);

  useEffect(() => {
    const node = root.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(node);
    return () => observer.disconnect();
  }, [updateScrollState]);

  const jumpToLatest = (): void => {
    const node = root.current;
    if (!node) return;
    followTail.current = true;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    setAwayFromLatest(false);
  };

  return { root, awayFromLatest, atTop, updateScrollState, jumpToLatest };
}

function latestWorkVisible(rows: readonly TranscriptRow[], starting: boolean): boolean {
  const latest = transcriptTurns(rows).at(-1) ?? [];
  return latest.some(
    (row) =>
      (row.timing && (!starting || !row.timing.finished)) ||
      (row.kind === "transient" && row.message.role === "assistant") ||
      (row.kind === "tool-group" &&
        (!starting || row.group.steps.some((step) => step.state === "running"))),
  );
}

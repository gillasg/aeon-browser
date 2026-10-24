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
import { HandoffCard, pendingHandoff } from "./handoff-card.js";
import type { TranscriptRow } from "./transcript-model.js";
import { TranscriptTurn, transcriptTurns, type TranscriptActions } from "./transcript-turn.js";

export function ChatTranscript({
  rows,
  onEditEntry,
  onBranchEntry,
  onPinMessage,
  actionsDisabled = false,
  running = false,
  starting = false,
  connecting = false,
  preparing = false,
}: {
  rows: readonly TranscriptRow[];
  onEditEntry?: (entryId: string) => Promise<void> | void;
  onBranchEntry?: (entryId: string) => Promise<void> | void;
  onPinMessage?: ((text: string) => Promise<void> | void) | undefined;
  actionsDisabled?: boolean;
  running?: boolean;
  starting?: boolean;
  connecting?: boolean;
  preparing?: boolean;
}): ReactElement {
  const { root, awayFromLatest, atTop, updateScrollState, jumpToLatest } =
    useTranscriptScroll(rows);
  const actions = turnActions({ actionsDisabled, onEditEntry, onBranchEntry, onPinMessage });
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
        {transcriptTurns(rows).map((turn, index, turns) => (
          <TranscriptTurn
            key={turn[0]?.key}
            rows={turn}
            actions={actions}
            live={Boolean(running) && index === turns.length - 1}
          />
        ))}
        <TranscriptTail
          rows={rows}
          running={running}
          starting={starting}
          connecting={connecting}
          preparing={preparing}
        />
      </section>
      <AnnotationSelection root={root} />
      {awayFromLatest && <JumpToLatest onClick={jumpToLatest} />}
    </div>
  );
}

// What follows the last turn: a pending hand-off card, then the working/connecting indicator.
function TranscriptTail(props: {
  rows: readonly TranscriptRow[];
  running: boolean;
  starting: boolean;
  connecting: boolean;
  preparing: boolean;
}): ReactElement {
  const handoff = pendingHandoff(props.rows);
  return (
    <>
      {handoff && <HandoffCard key={handoff.toolCallId} handoff={handoff} />}
      {props.connecting ? (
        <PendingWork key="connecting" connecting />
      ) : props.preparing ? (
        <PendingWork key="preparing" preparing />
      ) : (
        (props.starting || props.running) &&
        !latestWorkVisible(props.rows, props.starting) && <PendingWork key="working" />
      )}
    </>
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

/** The action props every row gets, built once per render. */
function turnActions({
  actionsDisabled,
  onEditEntry,
  onBranchEntry,
  onPinMessage,
}: {
  actionsDisabled: boolean;
  onEditEntry?: ((entryId: string) => Promise<void> | void) | undefined;
  onBranchEntry?: ((entryId: string) => Promise<void> | void) | undefined;
  onPinMessage?: ((text: string) => Promise<void> | void) | undefined;
}): TranscriptActions {
  return {
    actionsDisabled,
    ...(onEditEntry ? { onEditEntry } : {}),
    ...(onBranchEntry ? { onBranchEntry } : {}),
    ...(onPinMessage ? { onPinMessage } : {}),
  };
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

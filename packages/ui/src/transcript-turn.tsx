import { useEffect, useRef, useState, type ReactElement } from "react";
import type { TranscriptRow, ToolStep } from "./transcript-model.js";
import { ChatActivityGroup } from "./chat-activity.js";
import { DisclosureChevron } from "./activity-icons.js";
import { TranscriptMessage } from "./transcript-message.js";
import { TurnThinking } from "./turn-thinking.js";
import { AnswerLines } from "./answer-lines-view.js";
import type { AnswerOffer } from "./answer-lines.js";
import { runVisibleInterval } from "./visible-work.js";
import { showThinkingKey, useAgentFlag } from "./agent-tab-view.js";
import { describeToolAction } from "./chat-activity-summary.js";
import { formatSeconds, linesAfterReceipt, receiptText, receiptVia } from "./turn-receipt.js";
export interface TranscriptActions {
  actionsDisabled: boolean;
  onEditEntry?: (entryId: string) => Promise<void> | void;
  onBranchEntry?: (entryId: string) => Promise<void> | void;
  onPinMessage?: (text: string) => Promise<void> | void;
  onAnswerOffer?(offer: AnswerOffer): void;
  onAnswerWrong?(): void;
  /** Sends the turn's prompt again. */
  onRetry?(text: string): void;
}
export function transcriptTurns(rows: readonly TranscriptRow[]): TranscriptRow[][] {
  const turns: TranscriptRow[][] = [];
  for (const row of rows) {
    if ((row.kind === "entry" && row.entry.message?.role === "user") || !turns.length)
      turns.push([]);
    turns.at(-1)?.push(row);
  }
  return turns;
}
export function TranscriptTurn({
  rows,
  actions,
  live = false,
}: {
  rows: readonly TranscriptRow[];
  actions: TranscriptActions;
  /** The turn currently running; only it may tick. Earlier turns keep their duration. */
  live?: boolean;
}): ReactElement {
  const state = turnState(rows, live);
  const outer = useRef<HTMLDetailsElement>(null);
  const now = useTurnClock(state.active, outer);
  const [showThinking] = useAgentFlag(showThinkingKey, true);
  if (!state.hasWork)
    return (
      <>
        {rows.map((row) => renderRow(row, actions))}
        {turnLines(rows, actions, undefined)}
      </>
    );
  const seconds = secondsOf(rows, state.steps, state.active ? now : undefined);
  return (
    <>
      {state.before.map((row) => renderRow(row, actions))}
      <details
        ref={outer}
        className="activity-card transcript-turn"
        data-running={String(state.active)}
        data-failed={String(state.steps.some((step) => step.isError))}
      >
        <summary>
          <span className="activity-duration">
            {state.active ? workingLine(seconds, state.steps) : "Show work"}
          </span>
          <DisclosureChevron />
        </summary>
        <div className="turn-work">
          <TurnWork
            rows={state.work}
            latest={rows.at(-1)}
            active={state.active}
            actions={actions}
            showThinking={showThinking}
          />
          {showThinking && <TurnThinking rows={state.final} />}
        </div>
      </details>
      {state.final.map((row) => renderRow(row, actions, true))}
      {turnLines(rows, actions, state.active ? undefined : { seconds, final: state.final })}
    </>
  );
}

/** `Working · 4s — Reading editions on Steam`: the elapsed time and the step in plain words. */
function workingLine(seconds: number, steps: readonly ToolStep[]): string {
  const current = [...steps].reverse().find((step) => step.state === "running") ?? steps.at(-1);
  const prose = current ? describeToolAction(current) : "";
  return `Working · ${formatSeconds(seconds)}${prose ? ` — ${prose}` : ""}`;
}

function footerOf(rows: readonly TranscriptRow[]) {
  return rows.find((row) => row.kind === "entry" && row.entry.message?.role === "user")?.footer;
}

function textOf(row: TranscriptRow | undefined, role: "user" | "assistant"): string {
  if (!row || row.kind === "tool-group") return "";
  const message = row.kind === "transient" ? row.message : row.entry.message;
  if (message?.role !== role) return "";
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

function turnLines(
  rows: readonly TranscriptRow[],
  actions: TranscriptActions,
  done: { seconds: number; final: readonly TranscriptRow[] } | undefined,
): ReactElement | null {
  const footer = footerOf(rows);
  const prompt = rows.map((row) => textOf(row, "user")).find(Boolean) ?? "";
  const answer = done
    ? done.final
        .map((row) => textOf(row, "assistant"))
        .filter(Boolean)
        .join("\n\n")
    : "";
  const retry = done && actions.onRetry && prompt ? () => actions.onRetry?.(prompt) : undefined;
  const shown = footer ? (done ? linesAfterReceipt(footer) : footer) : { lines: [] };
  return (
    <AnswerLines
      footer={shown}
      disabled={actions.actionsDisabled}
      {...(done ? { duration: receiptText(done.seconds, receiptVia(footer)) } : {})}
      {...(answer ? { copyText: answer } : {})}
      {...(actions.onAnswerOffer ? { onOffer: actions.onAnswerOffer } : {})}
      {...(retry ? { onRetry: retry } : {})}
    />
  );
}
function turnState(rows: readonly TranscriptRow[], live: boolean) {
  const steps = rows.flatMap((row) => (row.kind === "tool-group" ? row.group.steps : []));
  const streaming = rows.some(
    (row) => row.kind === "transient" && row.message.role === "assistant",
  );
  const timing = rows.find((row) => row.timing)?.timing;
  // Only the turn that is running now ticks. An earlier turn stays fixed even if its run's
  // last events arrived after the next prompt was already queued.
  const active =
    live &&
    !timing?.finished &&
    (Boolean(timing) || streaming || steps.some((step) => step.state === "running"));
  const userIndex = rows.findIndex(
    (row) => row.kind === "entry" && row.entry.message?.role === "user",
  );
  const body = rows.slice(userIndex + 1);
  const index = findFinalAnswer(body);
  return {
    steps,
    timing,
    active,
    hasWork: Boolean(steps.length || active),
    before: rows.slice(0, userIndex + 1),
    work: index < 0 ? body : body.slice(0, index),
    final: index < 0 ? [] : body.slice(index),
  };
}
function TurnWork({
  rows,
  latest,
  active,
  actions,
  showThinking,
}: {
  rows: readonly TranscriptRow[];
  latest: TranscriptRow | undefined;
  active: boolean;
  actions: TranscriptActions;
  showThinking: boolean;
}): ReactElement {
  return (
    <>
      {rows.map((row) =>
        row.kind === "tool-group" ? (
          <ChatActivityGroup
            key={row.key}
            group={row.group}
            aggregateOnly
            streaming={active && row === latest}
          />
        ) : (
          renderRow(row, actions, !showThinking)
        ),
      )}
    </>
  );
}
function findFinalAnswer(rows: readonly TranscriptRow[]): number {
  let lastTool = -1;
  rows.forEach((row, index) => {
    if (row.kind === "tool-group") lastTool = index;
  });
  return rows.findIndex(
    (row, index) =>
      index > lastTool &&
      ((row.kind === "entry" &&
        row.entry.message?.role === "assistant" &&
        row.entry.message.stopReason === "stop") ||
        (row.kind === "transient" &&
          row.message.role === "assistant" &&
          row.message.content.some((block) => block.type === "text" && block.text.trim()))),
  );
}
function renderRow(
  row: TranscriptRow,
  actions: TranscriptActions,
  hideThinking = false,
): ReactElement {
  if (row.kind === "tool-group")
    return <ChatActivityGroup key={row.key} group={row.group} aggregateOnly />;
  return <TranscriptMessage key={row.key} row={row} hideThinking={hideThinking} {...actions} />;
}
/** The turn's own span: its start, and its last event unless it is still running. */
function secondsOf(
  rows: readonly TranscriptRow[],
  steps: readonly ToolStep[],
  now?: number,
): number {
  const found = rows.find((row) => row.timing)?.timing;
  const timestamps = rows.flatMap((row) =>
    row.kind === "entry" && row.entry.message?.role === "assistant"
      ? [Date.parse(row.entry.timestamp)].filter(Number.isFinite)
      : [],
  );
  const ownEnd = Math.max(
    ...timestamps,
    ...steps.map((step) => step.endedAt ?? step.lastActivityAt ?? step.startedAt),
  );
  // A settled turn can be handed the next run's live timing while that run streams; it starts
  // after everything this turn did, so it is not this turn's span (it read as "0s").
  const timing =
    !now && found && Number.isFinite(ownEnd) && found.startedAt > ownEnd ? undefined : found;
  const start =
    timing?.startedAt ?? Math.min(...timestamps, ...steps.map((step) => step.startedAt));
  const end =
    now ??
    Math.max(
      timing?.lastTokenAt ?? 0,
      ...timestamps,
      ...steps.map((step) => step.endedAt ?? step.lastActivityAt ?? step.startedAt),
    );
  return Math.max(0, Math.floor((end - start) / 1000) || 0);
}

/** A turn's header for tests: whether it is ticking, and the seconds it shows. */
export function turnSummary(
  rows: readonly TranscriptRow[],
  live: boolean,
  now: number,
): { active: boolean; seconds: number } {
  const state = turnState(rows, live);
  return {
    active: state.active,
    seconds: secondsOf(rows, state.steps, state.active ? now : undefined),
  };
}
function useTurnClock(active: boolean, outer: React.RefObject<HTMLDetailsElement | null>): number {
  const initialized = useRef(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) {
      if (outer.current) outer.current.open = false;
      return;
    }
    if (!initialized.current && outer.current) outer.current.open = true;
    initialized.current = true;
    // Only a visible chat needs a live elapsed time; a background tab's 250 ms tick re-renders
    // every turn and tool row even when nobody can see it.
    return runVisibleInterval(() => setNow(Date.now()), 250);
  }, [active]);
  return now;
}

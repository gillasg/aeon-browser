import { useEffect, useRef, useState, type ReactElement } from "react";
import type { TranscriptRow, ToolStep } from "./transcript-model.js";
import { ChatActivityGroup } from "./chat-activity.js";
import { DisclosureChevron } from "./activity-icons.js";
import { TranscriptMessage } from "./transcript-message.js";
import { TurnThinking } from "./turn-thinking.js";
export interface TranscriptActions {
  actionsDisabled: boolean;
  onEditEntry?: (entryId: string) => Promise<void> | void;
  onBranchEntry?: (entryId: string) => Promise<void> | void;
  onPinMessage?: (text: string) => Promise<void> | void;
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
}: {
  rows: readonly TranscriptRow[];
  actions: TranscriptActions;
}): ReactElement {
  const state = turnState(rows);
  const outer = useRef<HTMLDetailsElement>(null);
  const now = useTurnClock(state.active, outer);
  if (!state.hasWork) return <>{rows.map((row) => renderRow(row, actions))}</>;
  const end = state.timing
    ? state.timing.finished
      ? state.timing.lastTokenAt
      : now
    : state.active
      ? now
      : undefined;
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
            {state.active ? "Working" : "Worked"} for {duration(rows, state.steps, end)}
          </span>
          <DisclosureChevron />
        </summary>
        <div className="turn-work">
          <TurnWork
            rows={state.work}
            latest={rows.at(-1)}
            active={state.active}
            actions={actions}
          />
          <TurnThinking rows={state.final} />
        </div>
      </details>
      {state.final.map((row) => renderRow(row, actions, true))}
    </>
  );
}
function turnState(rows: readonly TranscriptRow[]) {
  const steps = rows.flatMap((row) => (row.kind === "tool-group" ? row.group.steps : []));
  const streaming = rows.some(
    (row) => row.kind === "transient" && row.message.role === "assistant",
  );
  const timing = rows.find((row) => row.timing)?.timing;
  const active =
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
}: {
  rows: readonly TranscriptRow[];
  latest: TranscriptRow | undefined;
  active: boolean;
  actions: TranscriptActions;
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
          renderRow(row, actions)
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
function duration(
  rows: readonly TranscriptRow[],
  steps: readonly ToolStep[],
  now?: number,
): string {
  const timing = rows.find((row) => row.timing)?.timing;
  const timestamps = rows.flatMap((row) =>
    row.kind === "entry" && row.entry.message?.role === "assistant"
      ? [Date.parse(row.entry.timestamp)]
      : [],
  );
  const start =
    timing?.startedAt ?? Math.min(...timestamps, ...steps.map((step) => step.startedAt));
  const end =
    now ??
    Math.max(
      ...timestamps,
      ...steps.map((step) => step.endedAt ?? step.lastActivityAt ?? step.startedAt),
    );
  const seconds = Math.max(0, Math.floor((end - start) / 1000) || 0);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
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
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

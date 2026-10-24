import type { PiSessionEventDto, PiMessageDto } from "@aeon/protocol";
import type { TranscriptRow } from "./transcript-model.js";
export interface TurnTiming {
  startedAt: number;
  lastTokenAt: number;
  finished: boolean;
}

/**
 * Each turn's own span. Events are attributed to the turn whose user prompt they follow, but a
 * run's last events can arrive after the next prompt is already queued: an idle or final message
 * only counts when that turn has work of its own, so the new prompt starts clean.
 */
export function updateTurnTiming(
  rows: readonly TranscriptRow[],
  event: PiSessionEventDto,
  now = Date.now(),
): void {
  const user = findUser(rows);
  if (!user) return;
  if (startsWork(event)) user.timing = startTiming(user.timing, now);
  const ownWork = workAfter(rows, user);
  const token = outputEvent(event);
  if (token && ownWork) {
    user.timing = startTiming(user.timing, now);
    user.timing.lastTokenAt = now;
    user.timing.finished = event.kind === "message-end" && event.message.stopReason !== "toolUse";
  }
  if (isIdle(event) && user.timing && ownWork) user.timing.finished = true;
}

function startTiming(existing: TurnTiming | undefined, now: number): TurnTiming {
  return existing && !existing.finished
    ? existing
    : { startedAt: now, lastTokenAt: now, finished: false };
}

function hasOutput(message: PiMessageDto): boolean {
  return message.content.some((block) =>
    block.type === "text" || block.type === "thinking"
      ? Boolean(block.text)
      : block.type === "tool-call",
  );
}

function findUser(rows: readonly TranscriptRow[]): TranscriptRow | undefined {
  return [...rows]
    .reverse()
    .find((row) => row.kind === "entry" && row.entry.message?.role === "user");
}

/** Whether the turn that starts at this user row has produced anything of its own. */
function workAfter(rows: readonly TranscriptRow[], user: TranscriptRow): boolean {
  const index = rows.indexOf(user);
  if (index < 0) return false;
  return rows
    .slice(index + 1)
    .some(
      (row) =>
        row.kind === "transient" ||
        (row.kind === "tool-group" && row.group.steps.length > 0) ||
        (row.kind === "entry" &&
          (row.entry.message?.role === "assistant" || row.entry.message?.role === "tool")),
    );
}

function isIdle(event: PiSessionEventDto): boolean {
  return event.kind === "run-state" && event.state === "idle";
}

function startsWork(event: PiSessionEventDto): boolean {
  return (
    (event.kind === "run-state" && event.state !== "idle") ||
    (event.kind === "entry-added" && event.entry.message?.role === "user")
  );
}
function outputEvent(
  event: PiSessionEventDto,
): event is Extract<
  PiSessionEventDto,
  { kind: "message-start" | "message-update" | "message-end" }
> {
  return (
    (event.kind === "message-update" ||
      event.kind === "message-start" ||
      event.kind === "message-end") &&
    event.message.role === "assistant" &&
    hasOutput(event.message)
  );
}

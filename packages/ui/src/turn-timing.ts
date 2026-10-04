import type { PiSessionEventDto, PiMessageDto } from "@pippin/protocol";
import type { TranscriptRow } from "./transcript-model.js";
export interface TurnTiming {
  startedAt: number;
  lastTokenAt: number;
  finished: boolean;
}
export function updateTurnTiming(rows: readonly TranscriptRow[], event: PiSessionEventDto): void {
  const user = findUser(rows);
  if (!user) return;
  if (startsWork(event))
    user.timing ??= { startedAt: Date.now(), lastTokenAt: Date.now(), finished: false };
  const token = outputEvent(event);
  if (token) {
    const now = Date.now();
    user.timing ??= { startedAt: now, lastTokenAt: now, finished: false };
    if (event.kind !== "message-end") user.timing.lastTokenAt = now;
    user.timing.finished = event.kind === "message-end" && event.message.stopReason !== "toolUse";
  }
  if (isIdle(event) && user.timing) user.timing.finished = true;
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

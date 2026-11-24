import { WebSocket } from "ws";
import {
  CoreActivityRequestSchema,
  CoreActivityResultSchema,
  handoffStatusLine,
  type HandoffStatus,
} from "@aeon/protocol";

export interface ActivityCounts {
  workingChats: number;
  askingChats: number;
  routines: number;
  cells: number;
  abilities: number;
  /** Hand-offs pending in browser tabs: one "Waiting on you: <msg> (2m 10s)" line each. */
  handoffs?: HandoffStatus[];
}

const BUSY_ROUTINE = new Set(["pending", "accepted", "running"]);

/** A due slot is queued. Pending, accepted, and running are work an update must not cut off. */
export function countBusyRoutines(runs: readonly { state: string }[]): number {
  return runs.filter((run) => BUSY_ROUTINE.has(run.state)).length;
}

export function activityBusy(counts: ActivityCounts, now = Date.now()): string[] {
  const lines: string[] = [];
  add(lines, counts.workingChats, "chat working", "chats working");
  add(lines, counts.askingChats, "chat waiting on you", "chats waiting on you");
  for (const handoff of counts.handoffs ?? []) lines.push(handoffStatusLine(handoff, now));
  add(lines, counts.routines, "routine running", "routines running");
  add(lines, counts.cells, "browser action running", "browser actions running");
  add(lines, counts.abilities, "ability running", "abilities running");
  return lines;
}

function add(lines: string[], count: number, one: string, many: string): void {
  if (count > 0) lines.push(`${count} ${count === 1 ? one : many}`);
}

export function idleActivity(): ActivityCounts {
  return { workingChats: 0, askingChats: 0, routines: 0, cells: 0, abilities: 0 };
}

/** Answers `core.activity`. A read failure stays busy so an update does not start blind. */
export function handleCoreActivity(
  socket: WebSocket,
  candidate: unknown,
  read: () => ActivityCounts,
): boolean {
  const request = CoreActivityRequestSchema.safeParse(candidate);
  if (!request.success) return false;
  const busy = readBusy(read);
  if (socket.readyState !== WebSocket.OPEN) return true;
  socket.send(
    JSON.stringify(
      CoreActivityResultSchema.parse({
        kind: "core.activity.result",
        requestId: request.data.requestId,
        idle: busy.length === 0,
        busy: busy.slice(0, 20),
      }),
    ),
  );
  return true;
}

function readBusy(read: () => ActivityCounts): string[] {
  try {
    return activityBusy(read());
  } catch {
    return ["activity could not be read"];
  }
}

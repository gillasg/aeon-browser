import type { RoutineRecord } from "@aeon/domain";
import { appendEventLog, type AeonEventKind, type AeonEventRecord } from "@aeon/location";
import { scrubSecrets } from "@aeon/protocol";
import { isListening } from "./routine-listeners.js";
import { isLive } from "./routine-listen.js";

type FiredRoutine = Pick<
  RoutineRecord,
  "routineId" | "title" | "sites" | "webhook" | "listen" | "check"
>;

/** What fired: a response listener, a webhook routine, or a plain watcher check. */
export function routineEventKind(routine: FiredRoutine): AeonEventKind {
  if (isListening(routine) || isLive(routine)) return "listener";
  return routine.webhook?.url ? "webhook" : "watcher";
}

/** Record a passed check for `aeon mcp` subscribers, scrubbed before it touches disk. */
export function recordRoutineEvent(
  dataDirectory: string,
  routine: FiredRoutine,
  value: unknown,
  now: () => Date = () => new Date(),
): Promise<AeonEventRecord> {
  return appendEventLog(dataDirectory, {
    kind: routineEventKind(routine),
    routineId: routine.routineId,
    site: routine.sites?.[0] ?? "",
    title: scrubSecrets(routine.title),
    value: scrubSecrets(value),
    firedAt: now().toISOString(),
  });
}

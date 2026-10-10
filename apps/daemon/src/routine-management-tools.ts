import { randomUUID } from "node:crypto";
import type { ChatId, AeonProductStore, RoutineRecord } from "@aeon/domain";
import { nextRoutineOccurrence, parseRoutineSchedule } from "./routine-schedule.js";
import type { RoutineScheduler } from "./routine-scheduler.js";

const ROUTINE_TOOLS = new Set([
  "create_routine",
  "preview_routine_schedule",
  "update_routine",
  "list_routines",
  "run_routine",
  "delete_routine",
]);

export function isRoutineTool(name: string): boolean {
  return ROUTINE_TOOLS.has(name);
}

export class RoutineManagementTools {
  constructor(
    private readonly store: AeonProductStore,
    private readonly routines: RoutineScheduler,
  ) {}

  execute(name: string, args: Record<string, unknown>, chatId: ChatId): unknown {
    switch (name) {
      case "create_routine":
        return this.create(args, chatId);
      case "preview_routine_schedule":
        return previewSchedule(args.schedule);
      case "update_routine":
        return this.update(args, chatId);
      case "list_routines":
        return this.store.listRoutines(chatId).map((routine) => ({
          ...routine,
          recentRuns: this.store.listRoutineRuns(routine.routineId, 10),
        }));
      case "run_routine":
        return this.run(args, chatId);
      case "delete_routine":
        return this.remove(args, chatId);
      default:
        throw new Error(`Unknown daemon routine tool '${name}'.`);
    }
  }

  private create(args: Record<string, unknown>, chatId: ChatId): RoutineRecord {
    const now = new Date();
    const schedule = parseRoutineSchedule(args.schedule, now);
    const timestamp = now.toISOString();
    const saved = this.store.createRoutine({
      routineId: randomUUID(),
      chatId,
      title: requiredString(args.title, "title"),
      instruction: requiredString(args.instruction, "instruction"),
      schedule,
      nextDueAt: nextRoutineOccurrence(schedule, now),
      requiredBrowserInstanceId: optionalNullableUuid(
        args.requiredBrowserInstanceId,
        "requiredBrowserInstanceId",
      ),
      enabled: true,
      deletedAt: null,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return this.store.getRoutine(saved.routineId) ?? saved;
  }

  private update(args: Record<string, unknown>, chatId: ChatId): RoutineRecord {
    const id = requiredString(args.routineId, "routineId");
    const current = this.requireOwned(id, chatId);
    const schedule = parseRoutineSchedule(args.schedule);
    const enabled = boolean(args.enabled, "enabled");
    const updated = this.store.updateRoutine(
      id,
      integer(args.expectedRevision),
      {
        title: requiredString(args.title, "title"),
        instruction: requiredString(args.instruction, "instruction"),
        schedule,
        requiredBrowserInstanceId: optionalNullableUuid(
          args.requiredBrowserInstanceId,
          "requiredBrowserInstanceId",
          current.requiredBrowserInstanceId,
        ),
        enabled,
        nextDueAt: enabled ? nextRoutineOccurrence(schedule, new Date()) : null,
      },
      new Date().toISOString(),
    );
    if (current.chatId !== updated.chatId)
      throw new Error("Routine ownership changed unexpectedly.");
    return updated;
  }

  private run(args: Record<string, unknown>, chatId: ChatId): unknown {
    const routine = this.requireOwned(requiredString(args.routineId, "routineId"), chatId);
    if (!routine.enabled) throw new Error("Enable this routine before running it manually.");
    return this.routines.runNow(routine.routineId);
  }

  private remove(args: Record<string, unknown>, chatId: ChatId): RoutineRecord {
    const routine = this.requireOwned(requiredString(args.routineId, "routineId"), chatId);
    return this.store.deleteRoutine(
      routine.routineId,
      integer(args.expectedRevision),
      new Date().toISOString(),
    );
  }

  private requireOwned(id: string, chatId: ChatId): RoutineRecord {
    const routine = this.store.getRoutine(id);
    if (!routine || routine.deletedAt || routine.chatId !== chatId)
      throw new Error("Routine does not exist in this Chat.");
    return routine;
  }
}

function previewSchedule(input: unknown): {
  schedule: ReturnType<typeof parseRoutineSchedule>;
  nextOccurrences: string[];
} {
  const now = new Date();
  const schedule = parseRoutineSchedule(input, now);
  const nextOccurrences: string[] = [];
  let cursor: Date | string = now;
  for (let index = 0; index < 3; index += 1) {
    const next = nextRoutineOccurrence(schedule, cursor);
    nextOccurrences.push(next);
    cursor = next;
  }
  return { schedule, nextOccurrences };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function integer(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0)
    throw new Error("expectedRevision is invalid.");
  return value as number;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function optionalNullableUuid(
  value: unknown,
  label: string,
  fallback: string | null = null,
): string | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new Error(`${label} must be a browser client instance UUID or null.`);
  return value;
}

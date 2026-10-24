import type Database from "better-sqlite3";
import type { ChatId } from "@aeon/domain";
import type {
  ClaimRoutineSlotsInput,
  RoutineRecord,
  RoutineRunPatch,
  RoutineRunRecord,
} from "@aeon/domain";
import {
  mayAdvance,
  toRoutine,
  toRoutineRun,
  type RoutineRow,
  type RoutineRunRow,
} from "./sqlite-routine-projection.js";

export class SqliteRoutineStore {
  constructor(private readonly database: Database.Database) {}

  createRoutine(record: RoutineRecord): RoutineRecord {
    this.database
      .prepare(
        `INSERT INTO routines
         (routine_id, chat_id, title, instruction, check_code, sites_json, schedule_json, next_due_at,
          required_browser_instance_id, enabled, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.routineId,
        record.chatId,
        record.title,
        record.instruction,
        record.check ?? null,
        JSON.stringify(record.sites ?? []),
        JSON.stringify(record.schedule),
        record.nextDueAt,
        record.requiredBrowserInstanceId ?? null,
        record.enabled ? 1 : 0,
        record.revision,
        record.createdAt,
        record.updatedAt,
      );
    const saved = this.getRoutine(record.routineId);
    if (!saved) throw new Error("Routine was not persisted.");
    return saved;
  }

  getRoutine(routineId: string): RoutineRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM routines WHERE routine_id = ?")
      .get(routineId) as RoutineRow | undefined;
    return row ? toRoutine(row) : undefined;
  }

  listRoutines(chatId?: ChatId): readonly RoutineRecord[] {
    const rows = (
      chatId
        ? this.database
            .prepare(
              "SELECT * FROM routines WHERE chat_id = ? AND deleted_at IS NULL ORDER BY created_at",
            )
            .all(chatId)
        : this.database
            .prepare("SELECT * FROM routines WHERE deleted_at IS NULL ORDER BY created_at")
            .all()
    ) as RoutineRow[];
    return rows.map(toRoutine);
  }

  listDueRoutines(now: string): readonly RoutineRecord[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM routines WHERE enabled = 1 AND deleted_at IS NULL AND next_due_at <= ? ORDER BY next_due_at",
      )
      .all(now) as RoutineRow[];
    return rows.map(toRoutine);
  }

  updateRoutine(
    routineId: string,
    expectedRevision: number,
    patch: Pick<
      RoutineRecord,
      | "title"
      | "instruction"
      | "check"
      | "sites"
      | "schedule"
      | "nextDueAt"
      | "requiredBrowserInstanceId"
      | "enabled"
    >,
    updatedAt: string,
  ): RoutineRecord {
    const result = this.database
      .prepare(
        `UPDATE routines SET title = ?, instruction = ?, check_code = ?, sites_json = ?, schedule_json = ?, next_due_at = ?,
         required_browser_instance_id = ?, enabled = ?, revision = revision + 1, updated_at = ?
         WHERE routine_id = ? AND revision = ? AND deleted_at IS NULL`,
      )
      .run(
        patch.title,
        patch.instruction,
        patch.check ?? null,
        JSON.stringify(patch.sites ?? []),
        JSON.stringify(patch.schedule),
        patch.nextDueAt,
        patch.requiredBrowserInstanceId ?? null,
        patch.enabled ? 1 : 0,
        updatedAt,
        routineId,
        expectedRevision,
      );
    if (result.changes !== 1)
      throw new Error("Routine revision changed; reload before updating it.");
    const saved = this.getRoutine(routineId);
    if (!saved) throw new Error("Routine was not persisted.");
    return saved;
  }

  deleteRoutine(routineId: string, expectedRevision: number, deletedAt: string): RoutineRecord {
    const result = this.database
      .prepare(
        `UPDATE routines SET deleted_at = ?, enabled = 0, next_due_at = NULL,
         revision = revision + 1, updated_at = ?
         WHERE routine_id = ? AND revision = ? AND deleted_at IS NULL`,
      )
      .run(deletedAt, deletedAt, routineId, expectedRevision);
    if (result.changes !== 1)
      throw new Error("Routine revision changed or the routine was deleted.");
    const saved = this.getRoutine(routineId);
    if (!saved) throw new Error("Routine was not persisted.");
    return saved;
  }

  claimDueRoutineSlots(input: ClaimRoutineSlotsInput): readonly RoutineRunRecord[] {
    return this.database.transaction(() => {
      const routine = this.getRoutine(input.routineId);
      if (
        !routine?.enabled ||
        routine.revision !== input.expectedRevision ||
        routine.nextDueAt !== input.expectedNextDueAt ||
        !routine.nextDueAt ||
        routine.nextDueAt > input.now ||
        !input.slots.length
      )
        return [];
      const active = this.database
        .prepare(
          `SELECT 1 FROM routine_runs WHERE routine_id = ?
           AND state IN ('due', 'pending', 'accepted', 'running') LIMIT 1`,
        )
        .get(input.routineId);
      const states = active
        ? input.slots.map(() => "coalesced" as const)
        : input.slots.map((_, index) =>
            index === input.slots.length - 1 ? ("due" as const) : ("skipped" as const),
          );
      const insert = this.database.prepare(
        `INSERT OR IGNORE INTO routine_runs
         (run_id, routine_id, chat_id, scheduled_slot, manual, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
      );
      input.slots.forEach((slot, index) => {
        insert.run(
          slot.runId,
          input.routineId,
          routine.chatId,
          slot.scheduledSlot,
          states[index],
          input.now,
          input.now,
        );
      });
      this.database
        .prepare(
          `UPDATE routines SET next_due_at = ?, updated_at = ?
           WHERE routine_id = ? AND revision = ?`,
        )
        .run(input.nextDueAt, input.now, input.routineId, input.expectedRevision);
      return input.slots
        .map(({ runId }) => this.getRoutineRun(runId))
        .filter((run): run is RoutineRunRecord => !!run);
    })();
  }

  createManualRoutineRun(input: {
    runId: string;
    routineId: string;
    scheduledSlot: string;
    now: string;
  }): RoutineRunRecord {
    return this.database.transaction(() => {
      const routine = this.getRoutine(input.routineId);
      if (!routine || !routine.enabled || routine.deletedAt)
        throw new Error("Routine does not exist or is disabled.");
      const active = this.database
        .prepare(
          `SELECT 1 FROM routine_runs WHERE routine_id = ?
           AND state IN ('due', 'pending', 'accepted', 'running') LIMIT 1`,
        )
        .get(input.routineId);
      this.database
        .prepare(
          `INSERT INTO routine_runs
           (run_id, routine_id, chat_id, scheduled_slot, manual, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          input.runId,
          input.routineId,
          routine.chatId,
          input.scheduledSlot,
          active ? "coalesced" : "due",
          input.now,
          input.now,
        );
      const saved = this.getRoutineRun(input.runId);
      if (!saved) throw new Error("Manual routine run was not persisted.");
      return saved;
    })();
  }

  getRoutineRun(runId: string): RoutineRunRecord | undefined {
    const row = this.database.prepare("SELECT * FROM routine_runs WHERE run_id = ?").get(runId) as
      RoutineRunRow | undefined;
    return row ? toRoutineRun(row) : undefined;
  }

  listDueRoutineRuns(limit: number): readonly RoutineRunRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM routine_runs WHERE state = 'due' ORDER BY created_at LIMIT ?")
      .all(limit) as RoutineRunRow[];
    return rows.map(toRoutineRun);
  }

  listOpenRoutineRuns(): readonly RoutineRunRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM routine_runs WHERE state IN ('due', 'pending', 'accepted', 'running')
         ORDER BY created_at`,
      )
      .all() as RoutineRunRow[];
    return rows.map(toRoutineRun);
  }

  listRoutineRuns(routineId: string, limit: number): readonly RoutineRunRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(routineId, limit) as RoutineRunRow[];
    return rows.map(toRoutineRun);
  }

  updateRoutineRun(runId: string, patch: RoutineRunPatch, updatedAt: string): RoutineRunRecord {
    const current = this.getRoutineRun(runId);
    if (!current) throw new Error("Routine run does not exist.");
    const state =
      patch.state && mayAdvance(current.state, patch.state) ? patch.state : current.state;
    this.database
      .prepare(
        `UPDATE routine_runs SET state = ?, pi_entry_id = ?, accepted_turn_id = ?,
         completed_at = ?, last_error = ?, updated_at = ? WHERE run_id = ?`,
      )
      .run(
        state,
        patch.piEntryId === undefined ? current.piEntryId : patch.piEntryId,
        patch.acceptedTurnId === undefined ? current.acceptedTurnId : patch.acceptedTurnId,
        patch.completedAt === undefined ? current.completedAt : patch.completedAt,
        patch.lastError === undefined ? current.lastError : patch.lastError,
        updatedAt,
        runId,
      );
    const saved = this.getRoutineRun(runId);
    if (!saved) throw new Error("Routine run update disappeared.");
    return saved;
  }
}

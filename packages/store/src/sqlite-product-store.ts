import type Database from "better-sqlite3";
import type {
  CapabilityAuditRecord,
  ChatId,
  ClaimRoutineSlotsInput,
  AeonProductStore,
  RoutineRecord,
  RoutineRunPatch,
  RoutineRunRecord,
} from "@aeon/domain";
import { SqliteCapabilityAuditStore } from "./sqlite-capability-audit-store.js";
import { SqliteRoutineStore } from "./sqlite-routine-store.js";

export class SqliteProductStore implements AeonProductStore {
  private readonly routines: SqliteRoutineStore;
  private readonly audit: SqliteCapabilityAuditStore;

  constructor(database: Database.Database) {
    this.routines = new SqliteRoutineStore(database);
    this.audit = new SqliteCapabilityAuditStore(database);
  }

  createRoutine = (record: RoutineRecord): RoutineRecord => this.routines.createRoutine(record);
  getRoutine = (routineId: string): RoutineRecord | undefined =>
    this.routines.getRoutine(routineId);
  listRoutines = (chatId?: ChatId): readonly RoutineRecord[] => this.routines.listRoutines(chatId);
  listDueRoutines = (now: string): readonly RoutineRecord[] => this.routines.listDueRoutines(now);
  updateRoutine = (
    routineId: string,
    expectedRevision: number,
    patch: Parameters<AeonProductStore["updateRoutine"]>[2],
    updatedAt: string,
  ): RoutineRecord => this.routines.updateRoutine(routineId, expectedRevision, patch, updatedAt);
  deleteRoutine = (routineId: string, expectedRevision: number, deletedAt: string): RoutineRecord =>
    this.routines.deleteRoutine(routineId, expectedRevision, deletedAt);
  claimDueRoutineSlots = (input: ClaimRoutineSlotsInput): readonly RoutineRunRecord[] =>
    this.routines.claimDueRoutineSlots(input);
  createManualRoutineRun = (
    input: Parameters<AeonProductStore["createManualRoutineRun"]>[0],
  ): RoutineRunRecord => this.routines.createManualRoutineRun(input);
  getRoutineRun = (runId: string): RoutineRunRecord | undefined =>
    this.routines.getRoutineRun(runId);
  listDueRoutineRuns = (limit: number): readonly RoutineRunRecord[] =>
    this.routines.listDueRoutineRuns(limit);
  listOpenRoutineRuns = (): readonly RoutineRunRecord[] => this.routines.listOpenRoutineRuns();
  listRoutineRuns = (routineId: string, limit: number): readonly RoutineRunRecord[] =>
    this.routines.listRoutineRuns(routineId, limit);
  updateRoutineRun = (runId: string, patch: RoutineRunPatch, updatedAt: string): RoutineRunRecord =>
    this.routines.updateRoutineRun(runId, patch, updatedAt);
  appendCapabilityAudit = (record: CapabilityAuditRecord): void =>
    this.audit.appendCapabilityAudit(record);
  listCapabilityAudit = (limit: number): readonly CapabilityAuditRecord[] =>
    this.audit.listCapabilityAudit(limit);
}

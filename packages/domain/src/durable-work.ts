import type { ChatId } from "./chat.js";

export type RoutineSchedule =
  | { kind: "interval"; everyMinutes: number; anchorUtc: string; timeZone: string }
  | { kind: "calendar"; daysOfWeek: number[]; localTime: string; timeZone: string };

export type RoutineRunState =
  | "due"
  | "pending"
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "unavailable"
  | "uncertain"
  | "skipped"
  | "coalesced";

export interface RoutineRecord {
  routineId: string;
  chatId: ChatId;
  title: string;
  instruction: string;
  schedule: RoutineSchedule;
  nextDueAt: string | null;
  requiredBrowserInstanceId: string | null;
  enabled: boolean;
  deletedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineRunRecord {
  runId: string;
  routineId: string;
  chatId: ChatId;
  scheduledSlot: string;
  manual: boolean;
  state: RoutineRunState;
  piEntryId: string | null;
  acceptedTurnId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
}

export interface RoutineRunPatch {
  state?: RoutineRunState;
  piEntryId?: string | null;
  acceptedTurnId?: string | null;
  completedAt?: string | null;
  lastError?: string | null;
}

export interface ClaimRoutineSlotsInput {
  routineId: string;
  expectedRevision: number;
  expectedNextDueAt: string;
  nextDueAt: string;
  now: string;
  slots: Array<{ runId: string; scheduledSlot: string }>;
}

export interface PiRoutineInvocation {
  runId: string;
  routineId: string;
  title: string;
  scheduledSlot: string;
  instruction: string;
}

export type PiRoutineRunEvent = {
  runId: string;
  chatId: ChatId;
  phase: "accepted" | "running" | "completed" | "failed";
  piEntryId?: string;
  acceptedTurnId?: string;
  message?: string;
};

export type PiRoutineRunEvidence =
  | { state: "not-found" }
  | { state: "accepted" | "running"; piEntryId: string; acceptedTurnId?: string }
  | {
      state: "completed" | "failed";
      piEntryId: string;
      acceptedTurnId: string;
    };

export interface EffectivePiResources {
  chatId: ChatId;
  sessionState: "not_started" | "loaded";
  revision: string;
  mcpServers: readonly PiMcpServerStatus[];
  skills: readonly { name: string; description: string; source: string }[];
  extensions: readonly { path: string; tools: readonly string[] }[];
  extensionErrors: readonly { path: string; error: string }[];
  tools: readonly { name: string; description: string; active: boolean }[];
}

export type PiMcpServerState =
  | "disabled"
  | "starting"
  | "connecting"
  | "connected"
  | "disconnected"
  | "needs-auth"
  | "failed"
  | "closed";

export interface PiMcpServerStatus {
  name: string;
  enabled: boolean;
  state: PiMcpServerState;
  toolCount: number;
  resourceCount: number;
}

export type CapabilityKind = "cli" | "mcp";
export type CapabilityVerification = {
  state: "needs_check" | "verified" | "failed";
  checkedAt: string | null;
  summary: string | null;
};

interface CapabilityBase {
  id: string;
  displayName: string;
  description: string;
  configReference: string;
  credentialReference: string | null;
  relatedSkillIds: string[];
  verification: CapabilityVerification;
}

export interface CliCapability extends CapabilityBase {
  kind: "cli";
  launcher: { executable: string; workingDirectory: string | null };
}

export interface McpCapability extends CapabilityBase {
  kind: "mcp";
  transport: "stdio" | "streamable-http";
  command: string | null;
  args: string[];
  endpoint: string | null;
  workingDirectory: string | null;
}

export type CapabilityDefinition = CliCapability | McpCapability;
export type CapabilityRegistryFile = {
  schemaVersion: 1;
  revision: number;
  capabilities: CapabilityDefinition[];
};

export interface CapabilityAuditRecord {
  revision: number;
  capabilityId: string;
  action: "register" | "update" | "remove" | "recheck" | "reconcile";
  actorChatId: ChatId | null;
  createdAt: string;
  result: string;
}

export interface AeonProductStore {
  createRoutine(record: RoutineRecord): RoutineRecord;
  getRoutine(routineId: string): RoutineRecord | undefined;
  listRoutines(chatId?: ChatId): readonly RoutineRecord[];
  listDueRoutines(now: string): readonly RoutineRecord[];
  updateRoutine(
    routineId: string,
    expectedRevision: number,
    patch: Pick<
      RoutineRecord,
      "title" | "instruction" | "schedule" | "nextDueAt" | "requiredBrowserInstanceId" | "enabled"
    >,
    updatedAt: string,
  ): RoutineRecord;
  deleteRoutine(routineId: string, expectedRevision: number, deletedAt: string): RoutineRecord;
  claimDueRoutineSlots(input: ClaimRoutineSlotsInput): readonly RoutineRunRecord[];
  createManualRoutineRun(input: {
    runId: string;
    routineId: string;
    scheduledSlot: string;
    now: string;
  }): RoutineRunRecord;
  getRoutineRun(runId: string): RoutineRunRecord | undefined;
  listDueRoutineRuns(limit: number): readonly RoutineRunRecord[];
  listOpenRoutineRuns(): readonly RoutineRunRecord[];
  listRoutineRuns(routineId: string, limit: number): readonly RoutineRunRecord[];
  updateRoutineRun(runId: string, patch: RoutineRunPatch, updatedAt: string): RoutineRunRecord;
  appendCapabilityAudit(record: CapabilityAuditRecord): void;
  listCapabilityAudit(limit: number): readonly CapabilityAuditRecord[];
}

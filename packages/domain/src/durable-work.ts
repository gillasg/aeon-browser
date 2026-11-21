import type { ChatId } from "./chat.js";
import type { CallEffect } from "./effect.js";

/** Where a passing check is delivered. The secret signs the body; it is never required. */
export interface RoutineWebhook {
  url: string;
  secret?: string;
}

/** What the last webhook attempt did, stored on the run. */
export interface WebhookDelivery {
  status: "delivered" | "failed";
  attempts: number;
  error?: string;
}

export type RoutineSchedule =
  | { kind: "interval"; everyMinutes: number; anchorUtc: string; timeZone: string }
  | { kind: "calendar"; daysOfWeek: number[]; localTime: string; timeZone: string }
  /** One run at an exact time: a snipe starts a little before its moment to warm up. */
  | { kind: "once"; atUtc: string; timeZone: string };

/**
 * Live watcher option: while a tab of the watched site is open in the user's Chrome, react to the
 * responses that page already loads instead of waiting for the timer. No extra requests are made.
 * `url` matches response URLs (a substring, or a /regex/); `type` is a resource type or MIME (e.g.
 * "json"). The check runs with `response` (its `.body` is the parsed response) as input.
 * When no matching tab is open the routine falls back to its normal schedule.
 */
export interface RoutineListen {
  url: string;
  type?: string;
}

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
  /** Watcher check: browser code the daemon runs first; the agent only wakes on a truthy result. */
  check: string | null;
  /**
   * Opt-in local shell check: a command the daemon runs on this machine before the agent wakes.
   * Exit 0 means met; stdout is the value. Never set by an agent without the user asking for it.
   */
  checkShell: string | null;
  /** Sites this routine may use (browserkit's "only" list); empty means no restriction. */
  sites: string[];
  /** Live watcher: react to matching responses on an open tab; null means timer-only. */
  listen: RoutineListen | null;
  schedule: RoutineSchedule;
  nextDueAt: string | null;
  requiredBrowserInstanceId: string | null;
  /** POST this when the check passes. Null means the routine only wakes Aeon. */
  webhook: RoutineWebhook | null;
  /** The check still runs; a pass does not start the agent. */
  webhookOnly: boolean;
  /** What calling this routine can do. Inferred when omitted, overridable. */
  effect: CallEffect;
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
  /** Set when this run tried to deliver a webhook. */
  webhookDelivery: WebhookDelivery | null;
}

export interface RoutineRunPatch {
  state?: RoutineRunState;
  piEntryId?: string | null;
  acceptedTurnId?: string | null;
  completedAt?: string | null;
  lastError?: string | null;
  webhookDelivery?: WebhookDelivery | null;
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
      | "title"
      | "instruction"
      | "check"
      | "checkShell"
      | "sites"
      | "listen"
      | "schedule"
      | "nextDueAt"
      | "requiredBrowserInstanceId"
      | "webhook"
      | "webhookOnly"
      | "effect"
      | "enabled"
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

import { asChatId, isCallEffect } from "@graft/domain";
import type {
  CallEffect,
  RoutineListen,
  RoutineRecord,
  RoutineRunRecord,
  RoutineWebhook,
  WebhookDelivery,
} from "@graft/domain";

export interface RoutineRow {
  routine_id: string;
  chat_id: string;
  title: string;
  instruction: string;
  check_code: string | null;
  check_shell: string | null;
  sites_json: string | null;
  listen_json: string | null;
  schedule_json: string;
  next_due_at: string | null;
  required_browser_instance_id: string | null;
  webhook_json: string | null;
  webhook_only: number | null;
  effect: string | null;
  enabled: number;
  deleted_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface RoutineRunRow {
  run_id: string;
  routine_id: string;
  chat_id: string;
  scheduled_slot: string;
  manual: number;
  state: RoutineRunRecord["state"];
  pi_entry_id: string | null;
  accepted_turn_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  last_error: string | null;
  webhook_delivery_json: string | null;
}

export function toRoutine(row: RoutineRow): RoutineRecord {
  return {
    routineId: row.routine_id,
    chatId: asChatId(row.chat_id),
    title: row.title,
    instruction: row.instruction,
    check: row.check_code ?? null,
    checkShell: row.check_shell ?? null,
    sites: sitesOf(row.sites_json),
    listen: listenOf(row.listen_json),
    schedule: JSON.parse(row.schedule_json) as RoutineRecord["schedule"],
    nextDueAt: row.next_due_at,
    requiredBrowserInstanceId: row.required_browser_instance_id,
    webhook: webhookOf(row.webhook_json),
    webhookOnly: row.webhook_only === 1,
    effect: effectOf(row.effect),
    enabled: row.enabled === 1,
    deletedAt: row.deleted_at,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toRoutineRun(row: RoutineRunRow): RoutineRunRecord {
  return {
    runId: row.run_id,
    routineId: row.routine_id,
    chatId: asChatId(row.chat_id),
    scheduledSlot: row.scheduled_slot,
    manual: row.manual === 1,
    state: row.state,
    piEntryId: row.pi_entry_id,
    acceptedTurnId: row.accepted_turn_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    lastError: row.last_error,
    webhookDelivery: deliveryOf(row.webhook_delivery_json),
  };
}

function effectOf(value: string | null): CallEffect {
  return isCallEffect(value) ? value : "write";
}

function webhookOf(value: string | null): RoutineWebhook | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed.url !== "string" || !parsed.url) return null;
    return {
      url: parsed.url,
      ...(typeof parsed.secret === "string" && parsed.secret ? { secret: parsed.secret } : {}),
    };
  } catch {
    return null;
  }
}

function deliveryOf(value: string | null): WebhookDelivery | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed?.status !== "delivered" && parsed?.status !== "failed") return null;
    const attempts = Number(parsed.attempts);
    return {
      status: parsed.status,
      attempts: Number.isFinite(attempts) ? attempts : 0,
      ...(typeof parsed.error === "string" && parsed.error ? { error: parsed.error } : {}),
    };
  } catch {
    return null;
  }
}

/** The optional live-watch filter; a database from before it has null. */
function listenOf(value: string | null): RoutineListen | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed.url !== "string" || !parsed.url) return null;
    return {
      url: parsed.url,
      ...(typeof parsed.type === "string" && parsed.type ? { type: parsed.type } : {}),
    };
  } catch {
    return null;
  }
}

/** The optional "only these sites" list; a database from before it has null. */
function sitesOf(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function mayAdvance(
  current: RoutineRunRecord["state"],
  next: RoutineRunRecord["state"],
): boolean {
  if (current === next) return true;
  if (current === "uncertain" && (next === "completed" || next === "failed")) return true;
  const rank: Record<RoutineRunRecord["state"], number> = {
    due: 0,
    pending: 1,
    accepted: 2,
    running: 3,
    completed: 4,
    failed: 4,
    unavailable: 4,
    uncertain: 4,
    skipped: 4,
    coalesced: 4,
  };
  return rank[next] >= rank[current] && rank[current] < 4;
}

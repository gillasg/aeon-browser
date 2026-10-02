import type Database from "better-sqlite3";
import { asChatId, type ChatId, type ChatRecord } from "@pippin/domain";
import type {
  CreateThreadDeliveryInput,
  ThreadCreationIntent,
  ThreadDeliveryPatch,
  ThreadDeliveryRecord,
} from "@pippin/domain";

interface ThreadDeliveryRow {
  delivery_id: string;
  idempotency_key: string;
  sender_chat_id: string;
  recipient_chat_id: string;
  sender_tool_call_id: string;
  payload_hash: string;
  mode: "followUp" | "steer";
  in_reply_to: string | null;
  state: ThreadDeliveryRecord["state"];
  pi_entry_id: string | null;
  pi_queue_item_id: string | null;
  accepted_turn_id: string | null;
  attempt: number;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
  completed_at: string | null;
  last_error: string | null;
}

interface ThreadCreationRow {
  sender_chat_id: string;
  idempotency_key: string;
  payload_hash: string;
  target_chat_id: string;
  created_at: string;
}

export class SqliteThreadStore {
  constructor(private readonly database: Database.Database) {}

  createThreadCreation(intent: ThreadCreationIntent, draft: ChatRecord): ThreadCreationIntent {
    return this.database.transaction(() => {
      const prior = this.getThreadCreation(intent.senderChatId, intent.idempotencyKey);
      if (prior) {
        assertSamePayload(prior.payloadHash, intent.payloadHash, "create_thread");
        return prior;
      }
      assertDraft(draft, intent.targetChatId);
      insertDraft(this.database, draft);
      this.database
        .prepare(
          `INSERT INTO thread_creations
          (sender_chat_id, idempotency_key, payload_hash, target_chat_id, created_at)
          VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          intent.senderChatId,
          intent.idempotencyKey,
          intent.payloadHash,
          intent.targetChatId,
          intent.createdAt,
        );
      return intent;
    })();
  }

  getThreadCreation(
    senderChatId: ChatId,
    idempotencyKey: string,
  ): ThreadCreationIntent | undefined {
    const row = this.database
      .prepare("SELECT * FROM thread_creations WHERE sender_chat_id = ? AND idempotency_key = ?")
      .get(senderChatId, idempotencyKey) as ThreadCreationRow | undefined;
    return row ? toThreadCreation(row) : undefined;
  }

  createThreadDelivery(input: CreateThreadDeliveryInput): {
    record: ThreadDeliveryRecord;
    created: boolean;
  } {
    return this.database.transaction(() => {
      const existing = this.getThreadDeliveryByIdempotency(
        input.senderChatId,
        input.idempotencyKey,
      );
      if (existing) {
        assertSamePayload(existing.payloadHash, input.payloadHash, "send_message_to_thread");
        if (existing.recipientChatId !== input.recipientChatId)
          throw new Error("This idempotency key already targets another thread.");
        return { record: existing, created: false };
      }
      this.database
        .prepare(
          `INSERT INTO thread_deliveries
          (delivery_id, idempotency_key, sender_chat_id, recipient_chat_id, sender_tool_call_id,
           payload_hash, mode, in_reply_to, state, attempt, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(
          input.deliveryId,
          input.idempotencyKey,
          input.senderChatId,
          input.recipientChatId,
          input.senderToolCallId,
          input.payloadHash,
          input.mode,
          input.inReplyTo,
          input.createdAt,
          input.createdAt,
        );
      const record = this.getThreadDelivery(input.deliveryId);
      if (!record) throw new Error("Pi delivery intent was not persisted.");
      return { record, created: true };
    })();
  }

  getThreadDelivery(deliveryId: string): ThreadDeliveryRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM thread_deliveries WHERE delivery_id = ?")
      .get(deliveryId) as ThreadDeliveryRow | undefined;
    return row ? toDelivery(row) : undefined;
  }

  getThreadDeliveryByIdempotency(
    senderChatId: ChatId,
    idempotencyKey: string,
  ): ThreadDeliveryRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM thread_deliveries WHERE sender_chat_id = ? AND idempotency_key = ?")
      .get(senderChatId, idempotencyKey) as ThreadDeliveryRow | undefined;
    return row ? toDelivery(row) : undefined;
  }

  listOpenThreadDeliveries(): readonly ThreadDeliveryRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM thread_deliveries
         WHERE state IN ('pending', 'submitting', 'accepted', 'queued', 'running')
         ORDER BY created_at ASC`,
      )
      .all() as ThreadDeliveryRow[];
    return rows.map(toDelivery);
  }

  updateThreadDelivery(
    deliveryId: string,
    patch: ThreadDeliveryPatch,
    updatedAt: string,
  ): ThreadDeliveryRecord {
    const columns: Array<[keyof ThreadDeliveryPatch, string]> = [
      ["state", "state"],
      ["piEntryId", "pi_entry_id"],
      ["piQueueItemId", "pi_queue_item_id"],
      ["acceptedTurnId", "accepted_turn_id"],
      ["attempt", "attempt"],
      ["acceptedAt", "accepted_at"],
      ["completedAt", "completed_at"],
      ["lastError", "last_error"],
    ];
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of columns) {
      if (patch[key] === undefined) continue;
      assignments.push(`${column} = ?`);
      values.push(patch[key]);
    }
    assignments.push("updated_at = ?");
    values.push(updatedAt, deliveryId);
    this.database
      .prepare(`UPDATE thread_deliveries SET ${assignments.join(", ")} WHERE delivery_id = ?`)
      .run(...(values as Array<string | number | null>));
    const record = this.getThreadDelivery(deliveryId);
    if (!record) throw new Error(`Delivery '${deliveryId}' does not exist.`);
    return record;
  }
}

export function insertDraft(database: Database.Database, draft: ChatRecord): void {
  database
    .prepare(
      `INSERT INTO chats
      (chat_id, title, project_id, working_directory, status, activation_id,
       pi_session_id, pi_session_file, pi_materialized, created_at, updated_at, pinned, archived)
      VALUES (?, ?, ?, ?, 'draft', NULL, NULL, NULL, 0, ?, ?, ?, ?)`,
    )
    .run(
      draft.chatId,
      draft.title,
      draft.projectId,
      draft.workingDirectory,
      draft.createdAt,
      draft.updatedAt,
      draft.pinned ? 1 : 0,
      draft.archived ? 1 : 0,
    );
}

export function assertDraft(draft: ChatRecord, chatId: ChatId): void {
  if (
    draft.chatId !== chatId ||
    draft.status !== "draft" ||
    draft.activationId ||
    draft.piReference ||
    draft.piMaterialized
  )
    throw new Error("A coordinated thread must start as a detached Chat draft.");
}

export function assertSamePayload(actual: string, expected: string, operation: string): void {
  if (actual !== expected)
    throw new Error(`${operation} idempotency key was reused with different input.`);
}

function toThreadCreation(row: ThreadCreationRow): ThreadCreationIntent {
  return {
    senderChatId: asChatId(row.sender_chat_id),
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    targetChatId: asChatId(row.target_chat_id),
    createdAt: row.created_at,
  };
}

function toDelivery(row: ThreadDeliveryRow): ThreadDeliveryRecord {
  return {
    deliveryId: row.delivery_id,
    idempotencyKey: row.idempotency_key,
    senderChatId: asChatId(row.sender_chat_id),
    recipientChatId: asChatId(row.recipient_chat_id),
    senderToolCallId: row.sender_tool_call_id,
    payloadHash: row.payload_hash,
    mode: row.mode,
    inReplyTo: row.in_reply_to,
    state: row.state,
    piEntryId: row.pi_entry_id,
    piQueueItemId: row.pi_queue_item_id,
    acceptedTurnId: row.accepted_turn_id,
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at,
    completedAt: row.completed_at,
    lastError: row.last_error,
  };
}

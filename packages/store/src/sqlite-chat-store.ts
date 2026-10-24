import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type ActivationId,
  type ChatId,
  type ChatListFilter,
  type ChatMetadataPatch,
  type ChatOrigin,
  type ChatRecord,
  type ChatStore,
  type ThreadCoordinationStore,
  type PiSessionReference,
  type ThreadCreationIntent,
  type ThreadDeliveryPatch,
  type ThreadDeliveryRecord,
  type ThreadForkIntent,
  type CreateThreadDeliveryInput,
  type CreateThreadForkInput,
  type AeonProductStore,
} from "@aeon/domain";
import { type ChatRow, toChatRecord } from "./chat-row.js";
import { migrate } from "./migrations.js";
import { SqliteThreadStore } from "./sqlite-thread-store.js";
import { SqliteThreadForkStore } from "./sqlite-thread-fork-store.js";
import { SqliteProductStore } from "./sqlite-product-store.js";

export function openChatStore(
  dataDirectory: string,
): ChatStore & ThreadCoordinationStore & AeonProductStore {
  const appData = resolve(dataDirectory);
  mkdirSync(appData, { recursive: true });
  const database = new Database(join(appData, "aeon.sqlite"));
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  migrate(database);
  return Object.assign(new SqliteChatStore(database), new SqliteProductStore(database));
}

class SqliteChatStore implements ChatStore, ThreadCoordinationStore {
  private readonly threads: SqliteThreadStore;
  private readonly forks: SqliteThreadForkStore;

  constructor(private readonly database: Database.Database) {
    this.threads = new SqliteThreadStore(database);
    this.forks = new SqliteThreadForkStore(database);
  }

  createDraft(record: ChatRecord): ChatRecord {
    if (record.status !== "draft" || record.activationId || record.piReference) {
      throw new Error("A new Chat must be an unattached draft.");
    }
    this.database
      .prepare(
        `INSERT INTO chats
        (chat_id, title, project_id, origin, working_directory, status, activation_id,
         pi_session_id, pi_session_file, pi_materialized, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'draft', NULL, NULL, NULL, 0, ?, ?)`,
      )
      .run(
        record.chatId,
        record.title,
        record.projectId,
        record.origin ?? "unknown",
        record.workingDirectory,
        record.createdAt,
        record.updatedAt,
      );
    return this.requireChat(record.chatId);
  }

  getChat(chatId: ChatId): ChatRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM chats WHERE chat_id = ? AND chat_id NOT IN (SELECT chat_id FROM deleted_chats)",
      )
      .get(chatId) as ChatRow | undefined;
    return row ? toChatRecord(row) : undefined;
  }

  listChats(
    limit: number,
    includeArchived = false,
    filter: ChatListFilter = {},
  ): readonly ChatRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Chat list limit must be between 1 and 100.");
    }
    const rows = this.database
      .prepare(CHAT_LIST_QUERY)
      .all(...chatListParams(includeArchived, filter), limit) as ChatRow[];
    return rows.map(toChatRecord);
  }

  listAllChats(): readonly ChatRecord[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM chats WHERE chat_id NOT IN (SELECT chat_id FROM deleted_chats) ORDER BY created_at",
      )
      .all() as ChatRow[];
    return rows.map(toChatRecord);
  }

  setChatOriginIfUnknown(chatId: ChatId, origin: ChatOrigin): boolean {
    const result = this.database
      .prepare("UPDATE chats SET origin = ? WHERE chat_id = ? AND origin = 'unknown'")
      .run(origin, chatId);
    return result.changes > 0;
  }

  listAgentCreatedChatIds(): readonly ChatId[] {
    const rows = this.database
      .prepare(
        `SELECT target_chat_id AS chatId FROM thread_creations
         UNION SELECT target_chat_id AS chatId FROM thread_forks`,
      )
      .all() as { chatId: string }[];
    return rows.map((row) => row.chatId as ChatId);
  }

  deleteChat(chatId: ChatId): void {
    this.requireChat(chatId);
    this.database.transaction(() => {
      const now = new Date().toISOString();
      this.database
        .prepare("INSERT INTO deleted_chats (chat_id, deleted_at) VALUES (?, ?)")
        .run(chatId, now);
      this.database
        .prepare("UPDATE routines SET enabled = 0, deleted_at = ? WHERE chat_id = ?")
        .run(now, chatId);
    })();
  }

  updateMetadata(chatId: ChatId, patch: ChatMetadataPatch): ChatRecord {
    const assignments: string[] = [];
    const values: (string | number)[] = [];
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title || title.length > 120) throw new Error("Chat title must be 1–120 characters.");
      assignments.push("title = ?");
      values.push(title);
    }
    if (patch.pinned !== undefined) {
      assignments.push("pinned = ?");
      values.push(patch.pinned ? 1 : 0);
    }
    if (patch.archived !== undefined) {
      assignments.push("archived = ?");
      values.push(patch.archived ? 1 : 0);
    }
    if (!assignments.length) throw new Error("Chat metadata update is empty.");
    assignments.push("updated_at = ?");
    values.push(new Date().toISOString(), chatId);
    this.database
      .prepare(`UPDATE chats SET ${assignments.join(", ")} WHERE chat_id = ?`)
      .run(...values);
    return this.requireChat(chatId);
  }

  beginActivation(chatId: ChatId, proposedId: ActivationId): ChatRecord {
    return this.database.transaction(() => {
      const chat = this.requireChat(chatId);
      if (chat.status === "draft") {
        this.database
          .prepare(
            "UPDATE chats SET status = 'creating', activation_id = ?, updated_at = ? WHERE chat_id = ? AND status = 'draft'",
          )
          .run(proposedId, new Date().toISOString(), chatId);
      } else if (chat.status === "failed") {
        this.database
          .prepare(
            "UPDATE chats SET status = 'creating', updated_at = ? WHERE chat_id = ? AND status = 'failed'",
          )
          .run(new Date().toISOString(), chatId);
      } else if (chat.status === "unavailable") {
        throw new Error(
          "The stored Pi session is unavailable and cannot be replaced automatically.",
        );
      }
      return this.requireChat(chatId);
    })();
  }

  attachPiSession(
    chatId: ChatId,
    activationId: ActivationId,
    reference: PiSessionReference,
    materialized: boolean,
  ): ChatRecord {
    return this.database.transaction(() => {
      const chat = this.requireChat(chatId);
      if (chat.activationId !== activationId || reference.sessionId !== activationId) {
        throw new Error("Pi session identity does not match the durable activation ID.");
      }
      if (chat.status === "ready" && sameReference(chat.piReference, reference)) return chat;
      if (chat.status !== "creating")
        throw new Error(`Cannot attach Pi while Chat is ${chat.status}.`);
      this.database
        .prepare(
          `UPDATE chats SET status = 'ready', pi_session_id = ?, pi_session_file = ?,
          pi_materialized = ?, updated_at = ? WHERE chat_id = ? AND status = 'creating' AND activation_id = ?`,
        )
        .run(
          reference.sessionId,
          reference.sessionFile,
          materialized ? 1 : 0,
          new Date().toISOString(),
          chatId,
          activationId,
        );
      return this.requireChat(chatId);
    })();
  }

  repairUnmaterializedPiReference(
    chatId: ChatId,
    activationId: ActivationId,
    reference: PiSessionReference,
  ): ChatRecord {
    return this.database.transaction(() => {
      const chat = this.requireChat(chatId);
      if (
        chat.status !== "ready" ||
        chat.activationId !== activationId ||
        chat.piMaterialized ||
        chat.piReference?.sessionId !== reference.sessionId ||
        reference.sessionId !== activationId
      ) {
        throw new Error("Only an unmaterialized Pi reference may be repaired.");
      }
      this.database
        .prepare("UPDATE chats SET pi_session_file = ?, updated_at = ? WHERE chat_id = ?")
        .run(reference.sessionFile, new Date().toISOString(), chatId);
      return this.requireChat(chatId);
    })();
  }

  markPiMaterialized(chatId: ChatId, sessionId: string): ChatRecord {
    this.database
      .prepare(
        `UPDATE chats SET pi_materialized = 1, updated_at = ?
        WHERE chat_id = ? AND pi_session_id = ? AND status = 'ready'`,
      )
      .run(new Date().toISOString(), chatId, sessionId);
    return this.requireChat(chatId);
  }

  markActivationFailed(chatId: ChatId, activationId: ActivationId): void {
    this.database
      .prepare(
        `UPDATE chats SET status = 'failed', updated_at = ?
        WHERE chat_id = ? AND activation_id = ? AND status = 'creating'`,
      )
      .run(new Date().toISOString(), chatId, activationId);
  }

  markPiUnavailable(chatId: ChatId, sessionId: string): ChatRecord {
    this.database
      .prepare(
        `UPDATE chats SET status = 'unavailable', updated_at = ?
        WHERE chat_id = ? AND pi_session_id = ? AND status = 'ready'`,
      )
      .run(new Date().toISOString(), chatId, sessionId);
    return this.requireChat(chatId);
  }

  createThreadCreation(intent: ThreadCreationIntent, draft: ChatRecord): ThreadCreationIntent {
    return this.threads.createThreadCreation(intent, draft);
  }

  getThreadCreation(
    senderChatId: ChatId,
    idempotencyKey: string,
  ): ThreadCreationIntent | undefined {
    return this.threads.getThreadCreation(senderChatId, idempotencyKey);
  }

  createThreadDelivery(input: CreateThreadDeliveryInput) {
    return this.threads.createThreadDelivery(input);
  }

  getThreadDelivery(deliveryId: string): ThreadDeliveryRecord | undefined {
    return this.threads.getThreadDelivery(deliveryId);
  }

  getThreadDeliveryByIdempotency(
    senderChatId: ChatId,
    idempotencyKey: string,
  ): ThreadDeliveryRecord | undefined {
    return this.threads.getThreadDeliveryByIdempotency(senderChatId, idempotencyKey);
  }

  listOpenThreadDeliveries(): readonly ThreadDeliveryRecord[] {
    return this.threads.listOpenThreadDeliveries();
  }

  updateThreadDelivery(deliveryId: string, patch: ThreadDeliveryPatch, updatedAt: string) {
    return this.threads.updateThreadDelivery(deliveryId, patch, updatedAt);
  }

  createThreadFork(input: CreateThreadForkInput, draft: ChatRecord): ThreadForkIntent {
    return this.forks.createThreadFork(input, draft);
  }

  getThreadFork(senderChatId: ChatId, idempotencyKey: string): ThreadForkIntent | undefined {
    return this.forks.getThreadFork(senderChatId, idempotencyKey);
  }

  listOpenThreadForks(): readonly ThreadForkIntent[] {
    return this.forks.listOpenThreadForks();
  }

  updateThreadFork(
    senderChatId: ChatId,
    idempotencyKey: string,
    patch: Pick<ThreadForkIntent, "state" | "piReference" | "updatedAt" | "lastError">,
  ): ThreadForkIntent {
    return this.forks.updateThreadFork(senderChatId, idempotencyKey, patch);
  }

  attachThreadForkedChat(
    senderChatId: ChatId,
    idempotencyKey: string,
    reference: PiSessionReference,
  ): ThreadForkIntent {
    return this.forks.attachThreadForkedChat(senderChatId, idempotencyKey, reference);
  }

  close(): void {
    if (this.database.open) this.database.close();
  }

  private requireChat(chatId: ChatId): ChatRecord {
    const row = this.database
      .prepare(
        "SELECT * FROM chats WHERE chat_id = ? AND chat_id NOT IN (SELECT chat_id FROM deleted_chats)",
      )
      .get(chatId) as ChatRow | undefined;
    if (!row) throw new Error(`Chat ${chatId} does not exist.`);
    return toChatRecord(row);
  }
}

function sameReference(left: PiSessionReference | null, right: PiSessionReference): boolean {
  return left?.sessionId === right.sessionId && left.sessionFile === right.sessionFile;
}

const CHAT_LIST_QUERY = `SELECT * FROM chats
  WHERE chat_id NOT IN (SELECT chat_id FROM deleted_chats)
    AND (? = 1 OR archived = 0)
    AND (? IS NULL OR origin = ?)
    AND (? IS NULL OR created_at >= ?)
    AND (? IS NULL OR created_at < ?)
  ORDER BY updated_at DESC, created_at DESC LIMIT ?`;

/** The origin and day range as query parameters; each filter is passed twice for `? IS NULL`. */
function chatListParams(
  includeArchived: boolean,
  filter: ChatListFilter,
): (string | number | null)[] {
  return [
    includeArchived ? 1 : 0,
    filter.origin ?? null,
    filter.origin ?? null,
    filter.since ?? null,
    filter.since ?? null,
    filter.until ?? null,
    filter.until ?? null,
  ];
}

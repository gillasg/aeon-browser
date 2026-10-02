import type Database from "better-sqlite3";
import {
  asChatId,
  type ChatId,
  type ChatRecord,
  type PiSessionReference,
  type ThreadForkIntent,
  type CreateThreadForkInput,
} from "@pippin/domain";
import { assertDraft, assertSamePayload, insertDraft } from "./sqlite-thread-store.js";

interface ThreadForkRow {
  sender_chat_id: string;
  idempotency_key: string;
  payload_hash: string;
  source_chat_id: string;
  source_entry_id: string;
  target_chat_id: string;
  title: string;
  state: ThreadForkIntent["state"];
  pi_session_id: string | null;
  pi_session_file: string | null;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

export class SqliteThreadForkStore {
  constructor(private readonly database: Database.Database) {}

  createThreadFork(input: CreateThreadForkInput, draft: ChatRecord): ThreadForkIntent {
    return this.database.transaction(() => {
      const prior = this.getThreadFork(input.senderChatId, input.idempotencyKey);
      if (prior) {
        assertSamePayload(prior.payloadHash, input.payloadHash, "fork_thread");
        return prior;
      }
      assertDraft(draft, input.targetChatId);
      insertDraft(this.database, draft);
      this.database
        .prepare(
          `INSERT INTO thread_forks
          (sender_chat_id, idempotency_key, payload_hash, source_chat_id, source_entry_id,
           target_chat_id, title, state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          input.senderChatId,
          input.idempotencyKey,
          input.payloadHash,
          input.sourceChatId,
          input.sourceEntryId,
          input.targetChatId,
          input.title,
          input.createdAt,
          input.createdAt,
        );
      const intent = this.getThreadFork(input.senderChatId, input.idempotencyKey);
      if (!intent) throw new Error("Pi fork intent was not persisted.");
      return intent;
    })();
  }

  getThreadFork(senderChatId: ChatId, idempotencyKey: string): ThreadForkIntent | undefined {
    const row = this.database
      .prepare("SELECT * FROM thread_forks WHERE sender_chat_id = ? AND idempotency_key = ?")
      .get(senderChatId, idempotencyKey) as ThreadForkRow | undefined;
    return row ? toFork(row) : undefined;
  }

  listOpenThreadForks(): readonly ThreadForkIntent[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM thread_forks WHERE state IN ('pending', 'uncertain') ORDER BY created_at ASC",
      )
      .all() as ThreadForkRow[];
    return rows.map(toFork);
  }

  updateThreadFork(
    senderChatId: ChatId,
    idempotencyKey: string,
    patch: Pick<ThreadForkIntent, "state" | "piReference" | "updatedAt" | "lastError">,
  ): ThreadForkIntent {
    this.database
      .prepare(
        `UPDATE thread_forks SET state = ?, pi_session_id = ?, pi_session_file = ?,
         updated_at = ?, last_error = ? WHERE sender_chat_id = ? AND idempotency_key = ?`,
      )
      .run(
        patch.state,
        patch.piReference?.sessionId ?? null,
        patch.piReference?.sessionFile ?? null,
        patch.updatedAt,
        patch.lastError,
        senderChatId,
        idempotencyKey,
      );
    const intent = this.getThreadFork(senderChatId, idempotencyKey);
    if (!intent) throw new Error("Pi fork intent does not exist.");
    return intent;
  }

  attachThreadForkedChat(
    senderChatId: ChatId,
    idempotencyKey: string,
    reference: PiSessionReference,
  ): ThreadForkIntent {
    return this.database.transaction(() => {
      const intent = this.getThreadFork(senderChatId, idempotencyKey);
      if (!intent) throw new Error("Pi fork intent does not exist.");
      if (intent.state === "ready") return intent;
      const chat = this.database
        .prepare("SELECT status FROM chats WHERE chat_id = ?")
        .get(intent.targetChatId) as { status: string } | undefined;
      if (!chat) throw new Error("Fork target Chat does not exist.");
      if (chat.status === "draft") {
        this.database
          .prepare(
            `UPDATE chats SET status = 'ready', activation_id = ?, pi_session_id = ?,
             pi_session_file = ?, pi_materialized = 1, updated_at = ? WHERE chat_id = ? AND status = 'draft'`,
          )
          .run(
            reference.sessionId,
            reference.sessionId,
            reference.sessionFile,
            new Date().toISOString(),
            intent.targetChatId,
          );
      } else {
        const row = this.database
          .prepare("SELECT pi_session_id, pi_session_file FROM chats WHERE chat_id = ?")
          .get(intent.targetChatId) as {
          pi_session_id: string | null;
          pi_session_file: string | null;
        };
        if (
          row.pi_session_id !== reference.sessionId ||
          row.pi_session_file !== reference.sessionFile
        )
          throw new Error("Fork target is already attached to a different Pi session.");
      }
      this.database
        .prepare(
          `UPDATE thread_forks SET state = 'ready', pi_session_id = ?, pi_session_file = ?,
           updated_at = ?, last_error = NULL WHERE sender_chat_id = ? AND idempotency_key = ?`,
        )
        .run(
          reference.sessionId,
          reference.sessionFile,
          new Date().toISOString(),
          senderChatId,
          idempotencyKey,
        );
      const complete = this.getThreadFork(senderChatId, idempotencyKey);
      if (!complete) throw new Error("Fork target was not committed.");
      return complete;
    })();
  }
}

function toFork(row: ThreadForkRow): ThreadForkIntent {
  return {
    senderChatId: asChatId(row.sender_chat_id),
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    sourceChatId: asChatId(row.source_chat_id),
    sourceEntryId: row.source_entry_id,
    targetChatId: asChatId(row.target_chat_id),
    title: row.title,
    state: row.state,
    piReference:
      row.pi_session_id && row.pi_session_file
        ? { sessionId: row.pi_session_id, sessionFile: row.pi_session_file }
        : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
  };
}

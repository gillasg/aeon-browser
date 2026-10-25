import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { migrate, STORE_SCHEMA_VERSION } from "../dist/migrations.js";

test("schema 3 fork intents migrate without losing rows and allow terminal failures", async (t) => {
  const root = resolve(await mkdtemp(join(tmpdir(), "aeon-fork-migration-")));
  assert.ok(root.startsWith(`${resolve(tmpdir())}${sep}`));
  const database = new Database(join(root, "aeon.sqlite"));
  database.pragma("foreign_keys = ON");
  t.after(() => database.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  createSchemaThreeForkTables(database);

  migrate(database);

  assert.equal(STORE_SCHEMA_VERSION, 12);
  assert.equal(
    database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version,
    STORE_SCHEMA_VERSION,
  );
  const preserved = database
    .prepare("SELECT state, source_entry_id FROM thread_forks WHERE idempotency_key = ?")
    .get("fork-before-upgrade");
  assert.deepEqual(preserved, { state: "pending", source_entry_id: "pi-entry-7" });
  database
    .prepare("UPDATE thread_forks SET state = 'failed' WHERE idempotency_key = ?")
    .run("fork-before-upgrade");
  assert.equal(
    database
      .prepare("SELECT state FROM thread_forks WHERE idempotency_key = ?")
      .get("fork-before-upgrade").state,
    "failed",
  );
  assert.deepEqual(database.pragma("foreign_key_check"), []);
});

function createSchemaThreeForkTables(database) {
  database.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (1, '2026-09-01'), (2, '2026-09-02'), (3, '2026-09-03');
    CREATE TABLE chats (chat_id TEXT PRIMARY KEY);
    INSERT INTO chats VALUES ('sender'), ('source'), ('target');
    CREATE TABLE thread_forks (
      sender_chat_id TEXT NOT NULL REFERENCES chats(chat_id),
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      source_chat_id TEXT NOT NULL REFERENCES chats(chat_id),
      source_entry_id TEXT NOT NULL,
      target_chat_id TEXT NOT NULL UNIQUE REFERENCES chats(chat_id),
      title TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'uncertain')),
      pi_session_id TEXT,
      pi_session_file TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT,
      PRIMARY KEY (sender_chat_id, idempotency_key)
    );
    CREATE INDEX thread_forks_pending ON thread_forks(state, updated_at);
    INSERT INTO thread_forks
      VALUES ('sender', 'fork-before-upgrade', 'hash', 'source', 'pi-entry-7', 'target',
        'Migration fixture', 'pending', NULL, NULL, '2026-09-03', '2026-09-03', NULL);
  `);
}

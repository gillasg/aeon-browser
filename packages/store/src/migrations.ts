import type Database from "better-sqlite3";

export const STORE_SCHEMA_VERSION = 11;

export function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  let current = readVersion(database);
  if (current > STORE_SCHEMA_VERSION)
    throw new Error(`Database schema ${current} is newer than this daemon supports.`);
  for (const [version, step] of MIGRATIONS) {
    if (current >= version) continue;
    step(database);
    current = version;
  }
}

/** Each schema change in order; the step records its own version row. */
const MIGRATIONS: readonly [number, (database: Database.Database) => void][] = [
  [1, migrateChats],
  [2, migrateChatMetadata],
  [3, migrateThreadCoordination],
  [4, migrateThreadForkFailure],
  [5, migrateDurableWork],
  [6, migrateRoutineDeletion],
  [7, migrateRoutineBrowserRequirement],
  [8, migrateDeletedChats],
  [9, migrateRoutineCheck],
  [10, migrateRoutineSites],
  [11, migrateChatOrigin],
  [12, migrateRoutineShellCheck],
];

function migrateRoutineShellCheck(database: Database.Database): void {
  database.transaction(() => {
    // Opt-in local shell check for a routine; null means none.
    database.exec("ALTER TABLE routines ADD COLUMN check_shell TEXT;");
    markVersion(database, 12);
  })();
}

function migrateDeletedChats(database: Database.Database): void {
  database.transaction(() => {
    database.exec(
      "CREATE TABLE deleted_chats (chat_id TEXT PRIMARY KEY REFERENCES chats(chat_id), deleted_at TEXT NOT NULL);",
    );
    markVersion(database, 8);
  })();
}

function migrateRoutineCheck(database: Database.Database): void {
  database.transaction(() => {
    // Optional watcher check: browser code run before the routine wakes the agent.
    database.exec("ALTER TABLE routines ADD COLUMN check_code TEXT;");
    markVersion(database, 9);
  })();
}

function migrateRoutineSites(database: Database.Database): void {
  database.transaction(() => {
    // Optional "only these sites" list: what a routine may use in the browser.
    database.exec("ALTER TABLE routines ADD COLUMN sites_json TEXT;");
    markVersion(database, 10);
  })();
}

function migrateChatOrigin(database: Database.Database): void {
  database.transaction(() => {
    // What started the chat. Existing chats are unknown until the backfill proves otherwise.
    database.exec(
      "ALTER TABLE chats ADD COLUMN origin TEXT NOT NULL DEFAULT 'unknown' CHECK (origin IN ('user', 'cli', 'mcp', 'companion', 'agent', 'routine', 'unknown'));",
    );
    markVersion(database, 11);
  })();
}

function migrateRoutineDeletion(database: Database.Database): void {
  database.transaction(() => {
    database.exec("ALTER TABLE routines ADD COLUMN deleted_at TEXT;");
    markVersion(database, 6);
  })();
}

function migrateRoutineBrowserRequirement(database: Database.Database): void {
  database.transaction(() => {
    database.exec("ALTER TABLE routines ADD COLUMN required_browser_instance_id TEXT;");
    markVersion(database, 7);
  })();
}

function migrateThreadForkFailure(database: Database.Database): void {
  database.transaction(() => {
    database.exec(`
      ALTER TABLE thread_forks RENAME TO thread_forks_v3;
      CREATE TABLE thread_forks (
        sender_chat_id TEXT NOT NULL REFERENCES chats(chat_id),
        idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        source_chat_id TEXT NOT NULL REFERENCES chats(chat_id),
        source_entry_id TEXT NOT NULL,
        target_chat_id TEXT NOT NULL UNIQUE REFERENCES chats(chat_id),
        title TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'failed', 'uncertain')),
        pi_session_id TEXT,
        pi_session_file TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT,
        PRIMARY KEY (sender_chat_id, idempotency_key)
      );
      INSERT INTO thread_forks SELECT * FROM thread_forks_v3;
      DROP TABLE thread_forks_v3;
      CREATE INDEX thread_forks_pending ON thread_forks(state, updated_at);
    `);
    markVersion(database, 4);
  })();
}

function migrateDurableWork(database: Database.Database): void {
  database.transaction(() => {
    database.exec(`
      CREATE TABLE routines (
        routine_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(chat_id),
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        next_due_at TEXT,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX routines_due ON routines(enabled, next_due_at);
      CREATE TABLE routine_runs (
        run_id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL REFERENCES routines(routine_id),
        chat_id TEXT NOT NULL REFERENCES chats(chat_id),
        scheduled_slot TEXT NOT NULL,
        manual INTEGER NOT NULL CHECK (manual IN (0, 1)),
        state TEXT NOT NULL CHECK (state IN ('due', 'pending', 'accepted', 'running', 'completed', 'failed', 'unavailable', 'uncertain', 'skipped', 'coalesced')),
        pi_entry_id TEXT,
        accepted_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        last_error TEXT,
        UNIQUE (routine_id, scheduled_slot)
      );
      CREATE INDEX routine_runs_open ON routine_runs(state, created_at);
      CREATE INDEX routine_runs_chat_state ON routine_runs(chat_id, state, created_at);
      CREATE TABLE capability_audit (
        registry_revision INTEGER PRIMARY KEY,
        capability_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('register', 'update', 'remove', 'recheck', 'reconcile')),
        actor_chat_id TEXT REFERENCES chats(chat_id),
        created_at TEXT NOT NULL,
        result TEXT NOT NULL
      );
    `);
    markVersion(database, 5);
  })();
}

function readVersion(database: Database.Database): number {
  const rows = database
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number }>;
  return rows.at(-1)?.version ?? 0;
}

function migrateChats(database: Database.Database): void {
  database.transaction(() => {
    database.exec(`
      CREATE TABLE chats (
        chat_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project_id TEXT,
        working_directory TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'creating', 'ready', 'failed', 'unavailable')),
        activation_id TEXT UNIQUE,
        pi_session_id TEXT UNIQUE,
        pi_session_file TEXT UNIQUE,
        pi_materialized INTEGER NOT NULL DEFAULT 0 CHECK (pi_materialized IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (status = 'draft' AND activation_id IS NULL AND pi_session_id IS NULL AND pi_session_file IS NULL AND pi_materialized = 0)
          OR (status IN ('creating', 'failed') AND activation_id IS NOT NULL AND pi_session_id IS NULL AND pi_session_file IS NULL AND pi_materialized = 0)
          OR (status IN ('ready', 'unavailable') AND activation_id IS NOT NULL AND pi_session_id IS NOT NULL AND pi_session_file IS NOT NULL)
        )
      );
      CREATE INDEX chats_updated_at ON chats(updated_at DESC);
    `);
    markVersion(database, 1);
  })();
}

function migrateChatMetadata(database: Database.Database): void {
  database.transaction(() => {
    database.exec(`
      ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));
      ALTER TABLE chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1));
    `);
    markVersion(database, 2);
  })();
}

function migrateThreadCoordination(database: Database.Database): void {
  database.transaction(() => {
    database.exec(`
      CREATE TABLE thread_creations (
        sender_chat_id TEXT NOT NULL REFERENCES chats(chat_id),
        idempotency_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        target_chat_id TEXT NOT NULL UNIQUE REFERENCES chats(chat_id),
        created_at TEXT NOT NULL,
        PRIMARY KEY (sender_chat_id, idempotency_key)
      );
      CREATE TABLE thread_deliveries (
        delivery_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        sender_chat_id TEXT NOT NULL REFERENCES chats(chat_id),
        recipient_chat_id TEXT NOT NULL REFERENCES chats(chat_id),
        sender_tool_call_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('followUp', 'steer')),
        in_reply_to TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'submitting', 'accepted', 'queued', 'running', 'completed', 'failed', 'uncertain')),
        pi_entry_id TEXT,
        pi_queue_item_id TEXT,
        accepted_turn_id TEXT,
        attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accepted_at TEXT,
        completed_at TEXT,
        last_error TEXT,
        UNIQUE (sender_chat_id, idempotency_key)
      );
      CREATE INDEX thread_deliveries_recipient_state
        ON thread_deliveries(recipient_chat_id, state, updated_at);
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
    `);
    markVersion(database, 3);
  })();
}

function markVersion(database: Database.Database, version: number): void {
  database
    .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
    .run(version, new Date().toISOString());
}

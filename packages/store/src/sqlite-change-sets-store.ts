import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** One stored set of browser.changes(): [key, item] pairs, as the last check saw them. */
export type ChangeSetEntries = Array<[string, unknown]>;

const MAX_BYTES = 4 * 1024 * 1024;

// browser.changes() baselines, kept per owner (a watcher's routine id, else a chat id) and name,
// so a watcher compares against its last run after the daemon restarts.
export class SqliteChangeSetsStore {
  private readonly database: Database.Database;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.database = new Database(join(directory, "graft-change-sets.sqlite"));
    this.database.pragma("journal_mode = WAL");
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS change_sets (owner TEXT NOT NULL, name TEXT NOT NULL, entries TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (owner, name))",
    );
  }
  get(owner: string, name: string): ChangeSetEntries | undefined {
    const row = this.database
      .prepare("SELECT entries FROM change_sets WHERE owner = ? AND name = ?")
      .get(owner, name) as { entries: string } | undefined;
    return row ? (JSON.parse(row.entries) as ChangeSetEntries) : undefined;
  }
  /** Saves the set; false when it is too large to keep (the runtime still compares in memory). */
  put(owner: string, name: string, entries: ChangeSetEntries): boolean {
    const json = JSON.stringify(entries);
    if (json.length > MAX_BYTES) return false;
    this.database
      .prepare(
        "INSERT INTO change_sets(owner, name, entries, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner, name) DO UPDATE SET entries = excluded.entries, updated_at = excluded.updated_at",
      )
      .run(owner, name, json, new Date().toISOString());
    return true;
  }
  /** Drops every set an owner kept (a deleted routine or chat). */
  deleteOwner(owner: string): void {
    this.database.prepare("DELETE FROM change_sets WHERE owner = ?").run(owner);
  }
  close(): void {
    this.database.close();
  }
}

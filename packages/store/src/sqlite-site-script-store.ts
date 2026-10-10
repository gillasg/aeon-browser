import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SiteScriptRecord } from "@aeon/domain";
export class SqliteSiteScriptStore {
  private readonly database: Database.Database;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.database = new Database(join(directory, "aeon-site-scripts.sqlite"));
    this.database.pragma("journal_mode = WAL");
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS scripts (id TEXT PRIMARY KEY, record TEXT NOT NULL)",
    );
  }
  list(): SiteScriptRecord[] {
    return this.database
      .prepare("SELECT record FROM scripts ORDER BY rowid")
      .all()
      .map((row) => JSON.parse((row as { record: string }).record) as SiteScriptRecord);
  }
  get(id: string): SiteScriptRecord | undefined {
    const row = this.database.prepare("SELECT record FROM scripts WHERE id = ?").get(id) as
      { record: string } | undefined;
    return row ? (JSON.parse(row.record) as SiteScriptRecord) : undefined;
  }
  put(script: SiteScriptRecord): void {
    this.database
      .prepare(
        "INSERT INTO scripts(id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record",
      )
      .run(script.scriptId, JSON.stringify(script));
  }
  delete(id: string): void {
    this.database.prepare("DELETE FROM scripts WHERE id = ?").run(id);
  }
  close(): void {
    this.database.close();
  }
}

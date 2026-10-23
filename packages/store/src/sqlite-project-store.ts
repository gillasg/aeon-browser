import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ProjectRecord } from "@aeon/domain";
export class SqliteProjectStore {
  private readonly database: Database.Database;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.database = new Database(join(directory, "piper-projects.sqlite"));
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS projects (project_id TEXT PRIMARY KEY, record TEXT NOT NULL)",
    );
  }
  list(): ProjectRecord[] {
    return this.database
      .prepare("SELECT record FROM projects ORDER BY rowid")
      .all()
      .map((row) => JSON.parse((row as { record: string }).record) as ProjectRecord);
  }
  get(id: string): ProjectRecord | undefined {
    const row = this.database
      .prepare("SELECT record FROM projects WHERE project_id = ?")
      .get(id) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as ProjectRecord) : undefined;
  }
  create(project: ProjectRecord): ProjectRecord {
    const value = project;
    this.database
      .prepare("INSERT INTO projects(project_id, record) VALUES (?, ?)")
      .run(value.projectId, JSON.stringify(value));
    return value;
  }
  update(project: ProjectRecord): ProjectRecord {
    const result = this.database
      .prepare("UPDATE projects SET record = ? WHERE project_id = ?")
      .run(JSON.stringify(project), project.projectId);
    if (!result.changes) throw new Error("Project not found.");
    return project;
  }
  close(): void {
    this.database.close();
  }
}

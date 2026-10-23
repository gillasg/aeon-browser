import type Database from "better-sqlite3";
import { asChatId, type CapabilityAuditRecord } from "@aeon/domain";

interface AuditRow {
  registry_revision: number;
  capability_id: string;
  action: CapabilityAuditRecord["action"];
  actor_chat_id: string | null;
  created_at: string;
  result: string;
}

export class SqliteCapabilityAuditStore {
  constructor(private readonly database: Database.Database) {}

  appendCapabilityAudit(record: CapabilityAuditRecord): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO capability_audit
         (registry_revision, capability_id, action, actor_chat_id, created_at, result)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.revision,
        record.capabilityId,
        record.action,
        record.actorChatId,
        record.createdAt,
        record.result,
      );
  }

  listCapabilityAudit(limit: number): readonly CapabilityAuditRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM capability_audit ORDER BY registry_revision DESC LIMIT ?")
      .all(limit) as AuditRow[];
    return rows.map((row) => ({
      revision: row.registry_revision,
      capabilityId: row.capability_id,
      action: row.action,
      actorChatId: row.actor_chat_id ? asChatId(row.actor_chat_id) : null,
      createdAt: row.created_at,
      result: row.result,
    }));
  }
}

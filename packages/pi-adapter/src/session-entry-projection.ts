import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { PiEntryCategory, PiEntryProjection, PiMessageProjection } from "@pippin/domain";
import { projectRoutineSettlement, PI_ROUTINE_SETTLEMENT_TYPE } from "./pi-routine.js";
import { projectCustomMessage, projectMessage } from "./pi-message-projection.js";

export function toEntryProjection(entry: SessionEntry): PiEntryProjection {
  const category = categoryOf(entry);
  let message: PiMessageProjection | null = null;
  if (entry.type === "message") message = projectMessage(entry.message);
  if (entry.type === "custom_message")
    message = projectCustomMessage(entry.customType, entry.details);
  if (entry.type === "custom")
    message = projectRoutineSettlement(entry.customType, entry.data) ?? null;
  return {
    entryId: entry.id,
    parentEntryId: entry.parentId,
    category,
    timestamp: entry.timestamp,
    message,
  };
}

function categoryOf(entry: SessionEntry): PiEntryCategory {
  if (entry.type === "message" || entry.type === "custom_message") return "message";
  if (entry.type === "custom" && entry.customType === PI_ROUTINE_SETTLEMENT_TYPE) return "message";
  if (
    entry.type === "session_info" ||
    entry.type === "model_change" ||
    entry.type === "thinking_level_change"
  )
    return "metadata";
  if (entry.type === "branch_summary" || entry.type === "compaction") return "branch";
  return "other";
}

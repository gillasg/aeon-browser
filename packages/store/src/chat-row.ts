import { type ActivationId, type ChatId, type ChatOrigin, type ChatRecord } from "@aeon/domain";

export interface ChatRow {
  chat_id: string;
  title: string;
  project_id: string | null;
  origin: ChatOrigin;
  pinned: number;
  archived: number;
  working_directory: string;
  status: ChatRecord["status"];
  activation_id: string | null;
  pi_session_id: string | null;
  pi_session_file: string | null;
  pi_materialized: number;
  created_at: string;
  updated_at: string;
}

export function toChatRecord(row: ChatRow): ChatRecord {
  return {
    chatId: row.chat_id as ChatId,
    title: row.title,
    projectId: row.project_id,
    origin: row.origin,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    workingDirectory: row.working_directory,
    status: row.status,
    activationId: row.activation_id as ActivationId | null,
    piReference:
      row.pi_session_id && row.pi_session_file
        ? { sessionId: row.pi_session_id, sessionFile: row.pi_session_file }
        : null,
    piMaterialized: row.pi_materialized === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

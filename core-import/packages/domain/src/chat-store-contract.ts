import type {
  ChatId,
  ChatRecord,
  ChatMetadataPatch,
  ActivationId,
  PiSessionReference,
} from "./chat.js";

export interface ChatStore {
  deleteChat?(chatId: ChatId): void;
  createDraft(record: ChatRecord): ChatRecord;
  getChat(chatId: ChatId): ChatRecord | undefined;
  listChats(limit: number, includeArchived?: boolean): readonly ChatRecord[];
  updateMetadata(chatId: ChatId, patch: ChatMetadataPatch): ChatRecord;
  beginActivation(chatId: ChatId, proposedId: ActivationId): ChatRecord;
  attachPiSession(
    chatId: ChatId,
    activationId: ActivationId,
    reference: PiSessionReference,
    materialized: boolean,
  ): ChatRecord;
  repairUnmaterializedPiReference(
    chatId: ChatId,
    activationId: ActivationId,
    reference: PiSessionReference,
  ): ChatRecord;
  markPiMaterialized(chatId: ChatId, sessionId: string): ChatRecord;
  markActivationFailed(chatId: ChatId, activationId: ActivationId): void;
  markPiUnavailable(chatId: ChatId, sessionId: string): ChatRecord;
  close(): void;
}

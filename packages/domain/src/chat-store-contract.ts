import type {
  ChatId,
  ChatListFilter,
  ChatOrigin,
  ChatRecord,
  ChatMetadataPatch,
  ActivationId,
  PiSessionReference,
} from "./chat.js";

export interface ChatStore {
  deleteChat?(chatId: ChatId): void;
  createDraft(record: ChatRecord): ChatRecord;
  getChat(chatId: ChatId): ChatRecord | undefined;
  listChats(
    limit: number,
    includeArchived?: boolean,
    filter?: ChatListFilter,
  ): readonly ChatRecord[];
  /** Every live chat, for the one-time origin backfill (not limited, archived included). */
  listAllChats(): readonly ChatRecord[];
  /** Fills an origin only while it is still unknown; returns whether it changed. */
  setChatOriginIfUnknown(chatId: ChatId, origin: ChatOrigin): boolean;
  /** Chats an agent's thread tool created (a create_thread or fork_thread target). */
  listAgentCreatedChatIds(): readonly ChatId[];
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

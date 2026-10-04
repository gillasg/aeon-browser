import type {
  ChatId,
  ChatMetadataPatch,
  ChatRecord,
  ChatStore,
  ChatSummary,
  PiSessionHandle,
} from "@pippin/domain";
import { titleFromPrompt, toChatSummary } from "./chat-projection.js";
import type { ChatEventHub } from "./chat-event-hub.js";

export class ChatMetadataService {
  constructor(
    private readonly store: ChatStore,
    private readonly events: ChatEventHub,
  ) {}

  update(chatId: ChatId, patch: ChatMetadataPatch): ChatSummary {
    const chat = this.store.updateMetadata(chatId, patch);
    this.publish(chat);
    return toChatSummary(chat);
  }

  nameInitialPrompt(chat: ChatRecord, session: PiSessionHandle, text: string): ChatRecord {
    // Model selection can create a session file before any conversation exists.
    if (
      chat.title !== "New Chat" ||
      session.snapshot().entries.some((entry) => entry.message?.role === "user")
    )
      return chat;
    const named = this.store.updateMetadata(chat.chatId, { title: titleFromPrompt(text) });
    this.publish(named);
    return named;
  }

  publish(chat: ChatRecord): void {
    const summary = toChatSummary(chat);
    this.events.publish(chat.chatId, {
      kind: "chat-metadata",
      title: summary.title,
      projectId: summary.projectId,
      pinned: summary.pinned,
      archived: summary.archived,
      updatedAt: summary.updatedAt,
    });
  }
}

import type { ActivationId, ChatRecord, ChatSummary } from "@pippin/domain";

export function toChatSummary(chat: ChatRecord): ChatSummary {
  return {
    chatId: chat.chatId,
    title: chat.title,
    projectId: chat.projectId,
    pinned: chat.pinned,
    archived: chat.archived,
    status: chat.status,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  };
}

export function titleFromPrompt(text: string): string {
  const compact = text.trim().replace(/\s+/g, " ");
  if (compact.length <= 64) return compact || "New Chat";
  return `${compact.slice(0, 61).trimEnd()}…`;
}

export function activationIdFor(chat: ChatRecord): ActivationId {
  if (chat.activationId) return chat.activationId;
  throw new Error("Activation journal is missing its stable ID.");
}

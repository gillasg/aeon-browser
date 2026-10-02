import {
  type ChatCatalogItem,
  type ChatRecord,
  type ChatStore,
  type ChatSummary,
  type PiSessionPort,
} from "@pippin/domain";

export async function searchChats(
  store: ChatStore,
  pi: PiSessionPort,
  query: string,
  limit = 50,
  includeArchived = true,
): Promise<{ chats: readonly ChatCatalogItem[]; searchWarnings: number }> {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized)
    return { chats: store.listChats(limit, includeArchived).map(toSummary), searchWarnings: 0 };
  const records = store.listChats(100, includeArchived);
  const hits: ChatCatalogItem[] = [];
  let searchWarnings = 0;
  for (const chat of records) {
    if (chat.title.toLocaleLowerCase().includes(normalized)) {
      hits.push({ ...toSummary(chat), matchExcerpt: chat.title });
      continue;
    }
    if (!chat.piReference || !chat.piMaterialized) continue;
    try {
      const match = await pi.searchTranscript(chat.piReference, chat.workingDirectory, normalized);
      if (match) hits.push({ ...toSummary(chat), matchExcerpt: match.excerpt });
    } catch {
      searchWarnings += 1;
    }
    if (hits.length >= limit) break;
  }
  return { chats: hits.slice(0, limit), searchWarnings };
}

function toSummary(chat: ChatRecord): ChatSummary {
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

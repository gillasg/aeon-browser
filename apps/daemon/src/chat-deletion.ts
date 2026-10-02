import type { ChatId, ChatStore, PiSessionHandle } from "@pippin/domain";
import type { ChatCommandGate } from "./chat-command-gate.js";
export async function deleteStoredChat(
  store: ChatStore,
  sessions: Map<ChatId, { session: PiSessionHandle; unsubscribe(): void }>,
  gate: ChatCommandGate,
  chatId: ChatId,
): Promise<void> {
  const active = sessions.get(chatId);
  if (active && active.session.snapshot().runState !== "idle")
    throw new Error("Stop the response before deleting this Chat.");
  await gate.run(chatId, async () => {
    if (!store.getChat(chatId)) throw new Error("Chat does not exist.");
    const observed = sessions.get(chatId);
    if (observed && observed.session.snapshot().runState !== "idle")
      throw new Error("Stop the response before deleting this Chat.");
    if (!store.deleteChat) throw new Error("Chat deletion is unavailable in this store.");
    store.deleteChat(chatId);
    observed?.unsubscribe();
    sessions.delete(chatId);
  });
}

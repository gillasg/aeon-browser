import { rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { ChatId, ChatRecord, ChatStore, PiSessionHandle } from "@aeon/domain";
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
    const chat = store.getChat(chatId);
    if (!chat) throw new Error("Chat does not exist.");
    const observed = sessions.get(chatId);
    if (observed && observed.session.snapshot().runState !== "idle")
      throw new Error("Stop the response before deleting this Chat.");
    if (!store.deleteChat) throw new Error("Chat deletion is unavailable in this store.");
    store.deleteChat(chatId);
    observed?.unsubscribe();
    sessions.delete(chatId);
    await removeChatFiles(chat, store.listAllChats());
  });
}

/**
 * A deleted chat's own files go with it: its workspace folder and its Pi session file. Only
 * folders Aeon made for this chat (`workspaces/<chatId>`) are removed, never a project folder the
 * user pointed a chat at, and a session file another chat still uses stays.
 */
export async function removeChatFiles(
  chat: ChatRecord,
  remaining: readonly ChatRecord[],
): Promise<void> {
  const own = basename(chat.workingDirectory) === chat.chatId;
  if (own && basename(dirname(chat.workingDirectory)) === "workspaces")
    await rm(chat.workingDirectory, { recursive: true, force: true }).catch(() => undefined);
  const file = chat.piReference?.sessionFile;
  if (!file || basename(dirname(file)) !== "pi-sessions") return;
  if (remaining.some((other) => other.piReference?.sessionFile === file)) return;
  await rm(file, { force: true }).catch(() => undefined);
}

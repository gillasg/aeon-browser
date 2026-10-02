import {
  BrowserContextDraftSchema,
  BrowserContextHandoffSchema,
  type BrowserContextDraft,
  type BrowserContextHandoff,
} from "@pippin/protocol";

export const CONTEXT_HANDOFF_PREFIX = "pippin-browser-context-handoff:";
const CHAT_CONTEXT_PREFIX = "pippin-chat-browser-context:";

export function handoffKey(invocationId: string): string {
  return `${CONTEXT_HANDOFF_PREFIX}${invocationId}`;
}

export function chatContextKey(chatId: string): string {
  return `${CHAT_CONTEXT_PREFIX}${chatId}`;
}

export function subscribeChatContextDraft(
  chatId: string,
  applyDraft: (value: unknown) => Promise<void>,
): Parameters<typeof chrome.storage.onChanged.removeListener>[0] {
  const key = chatContextKey(chatId);
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area === "session" && changes[key]) void applyDraft(changes[key]?.newValue);
  };
  chrome.storage.onChanged.addListener(listener);
  return listener;
}

export async function pendingHandoffs(windowId: number): Promise<BrowserContextHandoff[]> {
  const values = await chrome.storage.session.get(null);
  const handoffs: BrowserContextHandoff[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith(CONTEXT_HANDOFF_PREFIX)) continue;
    const result = BrowserContextHandoffSchema.safeParse(value);
    if (result.success && result.data.windowId === windowId && !result.data.chatId)
      handoffs.push(result.data);
  }
  return handoffs;
}

export async function readChatContext(chatId: string): Promise<BrowserContextDraft | undefined> {
  const key = chatContextKey(chatId);
  const stored = await chrome.storage.session.get(key);
  const parsed = BrowserContextDraftSchema.safeParse(stored[key]);
  return parsed.success ? parsed.data : undefined;
}

export async function saveChatContext(
  chatId: string,
  handoff: BrowserContextHandoff,
): Promise<BrowserContextDraft> {
  if (await readChatContext(chatId))
    throw new Error("This Chat already has page context. Send or remove its chip first.");
  const draft = BrowserContextDraftSchema.parse({
    invocationId: handoff.invocationId,
    context: handoff.context,
    ...(handoff.autoPrompt ? { autoPrompt: handoff.autoPrompt } : {}),
  });
  await chrome.storage.session.set({ [chatContextKey(chatId)]: draft });
  return draft;
}

export async function removeChatContext(chatId: string, contextId: string): Promise<void> {
  const current = await readChatContext(chatId);
  if (current?.context.contextId === contextId)
    await chrome.storage.session.remove(chatContextKey(chatId));
}

export async function clearAutoPrompt(chatId: string, invocationId: string): Promise<void> {
  const current = await readChatContext(chatId);
  if (current?.invocationId !== invocationId || !current.autoPrompt) return;
  await chrome.storage.session.set({
    [chatContextKey(chatId)]: { invocationId: current.invocationId, context: current.context },
  });
}

export async function updateContextStatus(
  chatId: string,
  contextId: string,
  sourceStatus: "current" | "stale" | "lost" | "offline",
): Promise<void> {
  const current = await readChatContext(chatId);
  if (current?.context.contextId !== contextId) return;
  await chrome.storage.session.set({
    [chatContextKey(chatId)]: {
      ...current,
      context: { ...current.context, sourceStatus },
    },
  });
}

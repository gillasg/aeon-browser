import { PiBrowserContextRecordSchema } from "@aeon/protocol";
import { readChatContext, saveChatContext } from "./browser-context-storage.js";
export async function stagePanelPrompt(chatId: string, prompt: unknown): Promise<void> {
  sessionStorage.setItem("aeon-panel-initial:" + chatId, JSON.stringify(prompt));
  await savePanelContext(chatId);
}

export async function savePanelContext(chatId: string): Promise<void> {
  const raw = sessionStorage.getItem("aeon-panel-page");
  if (!raw) return;
  const parsed = PiBrowserContextRecordSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) return;
  const currentWindow = await chrome.windows.getCurrent();
  if (currentWindow.id === undefined) return;
  await saveChatContext(chatId, {
    invocationId: crypto.randomUUID(),
    windowId: currentWindow.id,
    context: parsed.data,
  });
}

export async function ensurePanelContext(chatId: string): Promise<void> {
  if (document.body.dataset.host !== "panel" || (await readChatContext(chatId))) return;
  const raw = await chrome.runtime.sendMessage({ kind: "aeon.native.current-page" });
  const parsed = PiBrowserContextRecordSchema.safeParse(raw);
  if (!parsed.success) return;
  const currentWindow = await chrome.windows.getCurrent();
  if (currentWindow.id === undefined) return;
  await saveChatContext(chatId, {
    invocationId: crypto.randomUUID(),
    windowId: currentWindow.id,
    context: parsed.data,
  });
}

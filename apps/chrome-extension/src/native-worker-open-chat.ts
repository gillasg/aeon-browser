import { NativeOpenChatSchema } from "@graft/protocol";
import {
  expectAgentActivation,
  expectNextAgentActivation,
  trackAgentTab,
} from "@browserkit/engine/native-browser-tab-cleanup";
import { recordChatTab } from "@browserkit/engine/native-browser-takes";
import { chatUrl, findExistingChat } from "./native-worker-tabs.js";

// The Graft CLI/MCP starts chats through Core; Core asks the extension to show each one as a tab
// so the user can watch it work. Background by default; an open tab is reused, never duplicated.
export function handleOpenChatMessage(candidate: unknown, socket: WebSocket): boolean {
  const message = NativeOpenChatSchema.safeParse(candidate);
  if (!message.success) return false;
  const { chatId, active, typed } = message.data;
  if (typed) {
    void typeIntoChat(chatId, typed).then(
      (result) => reply(socket, { chatId, ok: true, ...result }),
      (error: unknown) =>
        reply(socket, {
          chatId,
          ok: false,
          error: String(error instanceof Error ? error.message : error).slice(0, 2000),
        }),
    );
    return true;
  }
  // The chat's tab id goes back, so `graft open` can print it.
  void openChat(chatId, active).then(
    (tabId) => replyOpened(socket, chatId, tabId),
    () => replyOpened(socket, chatId, undefined),
  );
  return true;
}

function reply(socket: WebSocket, body: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ kind: "native.chat.typed", ...body }));
}

/** The answer to native.chat.open: the chat's tab id, when Chrome gave one (the daemon reads it). */
export function chatOpenedMessage(
  chatId: string,
  tabId: number | undefined,
): Record<string, unknown> {
  return { kind: "native.chat.opened", chatId, ...(tabId !== undefined ? { tabId } : {}) };
}

function replyOpened(socket: WebSocket, chatId: string, tabId: number | undefined): void {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(chatOpenedMessage(chatId, tabId)));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * graft run --typed: open the chat's tab in the background, record it as one of the chat's takes
 * (when recordAgentTabs is on), and have the page type the prompt into its own composer. The
 * prompt is sent by the caller afterwards, so it never counts as the user typing.
 */
async function typeIntoChat(chatId: string, text: string): Promise<{ recording: boolean }> {
  const tabId = await openChat(chatId, false);
  if (tabId === undefined) throw new Error("the chat tab did not open");
  await loaded(tabId);
  const recording = await recordChatTab(tabId, chatId);
  // The recording's first frames arrive a moment after it starts: show the empty chat first.
  await sleep(recording ? 1500 : 300);
  for (let attempt = 0; ; attempt++) {
    try {
      const answer = (await chrome.runtime.sendMessage({
        kind: "graft.chat.type",
        chatId,
        text,
      })) as { typed?: boolean } | undefined;
      if (answer?.typed) return { recording };
    } catch (error) {
      // The page's script may not be listening yet.
      if (attempt >= 30) throw error;
    }
    if (attempt >= 30) throw new Error("the chat page did not type the prompt");
    await sleep(300);
  }
}

async function loaded(tabId: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await sleep(150);
  }
}

/** Shows the chat's tab (an open one is reused); resolves with its tab id. */
async function openChat(chatId: string, active: boolean): Promise<number | undefined> {
  const existing = await findExistingChat(chatId);
  if (existing?.id !== undefined) {
    if (active) {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return existing.id;
  }
  const window = await chrome.windows
    .getLastFocused({ windowTypes: ["normal"] })
    .catch(() => undefined);
  if (active) expectNextAgentActivation();
  const created = await chrome.tabs.create({
    url: chatUrl(chatId),
    active,
    ...(window?.id !== undefined ? { windowId: window.id } : {}),
  });
  // A chat tab is opened by Graft for its own run, whether it is shown or in the background. Track
  // both: otherwise a batch shown in front leaves one live chat page per task, and the idle sweep
  // cannot close a tab it does not know about. Graft's own activation does not mark it as seen, so
  // a tab the user later clicks is still kept; only the user's own attention protects a chat tab.
  if (created.id !== undefined) {
    if (active) expectAgentActivation(created.id);
    trackAgentTab(created.id, chatId, { url: chatUrl(chatId) });
  }
  return created.id;
}

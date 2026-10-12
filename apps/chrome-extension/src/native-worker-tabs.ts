import type { PageGrantScope } from "@aeon/protocol";
import {
  NativeExtensionRequestSchema,
  NativeOpenChatResponseSchema,
  NativeTakeInitialSubmitResponseSchema,
} from "./native-extension-message.js";
import {
  clearInitialSubmit,
  stageInitialSubmit,
  takeInitialSubmit,
} from "./native-initial-submit.js";

const nativeOrigin = new URL(chrome.runtime.getURL("/")).origin;
type OpenRequest = Extract<
  ReturnType<typeof NativeExtensionRequestSchema.parse>,
  { kind: "aeon.native.open-chat" }
>;

export function isPageScopeAllowed(
  sender: chrome.runtime.MessageSender,
  scope: PageGrantScope,
): boolean {
  const url = getOwnSenderUrl(sender);
  if (
    !url ||
    !["/home.html", "/sidepanel.html", "/chat.html", "/viewer.html"].includes(url.pathname)
  )
    return false;
  if (url.pathname === "/viewer.html")
    return scope.kind === "chat" && url.searchParams.get("chatId") === scope.chatId;
  if (scope.kind === "management") return url.pathname === "/home.html";
  return (
    scope.kind === "catalog" ||
    (url.pathname === "/chat.html" && url.searchParams.get("chatId") === scope.chatId)
  );
}

export function isOpenChatSender(sender: chrome.runtime.MessageSender): boolean {
  const url = getOwnSenderUrl(sender);
  return !!url && ["/home.html", "/sidepanel.html", "/chat.html"].includes(url.pathname);
}

export async function openNativeChat(
  sender: chrome.runtime.MessageSender,
  request: OpenRequest,
): Promise<unknown> {
  const senderUrl = getOwnSenderUrl(sender);
  if (!senderUrl || !isOpenRequestAllowed(senderUrl, request))
    return NativeOpenChatResponseSchema.parse({ ok: false, code: "INVALID_SENDER" });
  const existing = await findExistingChat(request.chatId);
  if (existing) return focusExistingChat(existing, request.initialSubmit !== undefined);
  const tab = await getChatTargetTab(sender, request);
  if (tab.id === undefined)
    return NativeOpenChatResponseSchema.parse({ ok: false, code: "TAB_UNAVAILABLE" });
  if (request.initialSubmit)
    await stageInitialSubmit(tab.id, request.chatId, request.initialSubmit);
  try {
    await chrome.tabs.update(tab.id, { url: chatUrl(request.chatId) });
  } catch (error) {
    if (request.initialSubmit) await clearInitialSubmit(tab.id);
    throw error;
  }
  return NativeOpenChatResponseSchema.parse({ ok: true, focusedExisting: false });
}

function isOpenRequestAllowed(senderUrl: URL, request: OpenRequest): boolean {
  if (request.reuseCurrentTab && !["/home.html", "/chat.html"].includes(senderUrl.pathname))
    return false;
  return (
    !request.initialSubmit ||
    (request.reuseCurrentTab === true && ["/home.html", "/chat.html"].includes(senderUrl.pathname))
  );
}

async function focusExistingChat(
  existing: chrome.tabs.Tab,
  hasInitialSubmit: boolean,
): Promise<unknown> {
  if (hasInitialSubmit)
    return NativeOpenChatResponseSchema.parse({ ok: false, code: "CHAT_ALREADY_OPEN" });
  if (existing.id === undefined)
    return NativeOpenChatResponseSchema.parse({ ok: false, code: "TAB_UNAVAILABLE" });
  await chrome.windows.update(existing.windowId, { focused: true });
  await chrome.tabs.update(existing.id, { active: true });
  return NativeOpenChatResponseSchema.parse({ ok: true, focusedExisting: true });
}

async function getChatTargetTab(
  sender: chrome.runtime.MessageSender,
  request: OpenRequest,
): Promise<chrome.tabs.Tab> {
  const senderTabId = request.reuseCurrentTab ? sender.tab?.id : undefined;
  return senderTabId === undefined
    ? chrome.tabs.create({
        url: "about:blank",
        active: true,
        ...(request.targetWindowId !== undefined ? { windowId: request.targetWindowId } : {}),
      })
    : chrome.tabs.get(senderTabId);
}

export async function takeNativeInitialSubmit(
  sender: chrome.runtime.MessageSender,
  chatId: string,
): Promise<unknown> {
  const senderUrl = getOwnSenderUrl(sender);
  const tabId = sender.tab?.id;
  if (
    !senderUrl ||
    senderUrl.pathname !== "/chat.html" ||
    senderUrl.searchParams.get("chatId") !== chatId
  )
    return NativeTakeInitialSubmitResponseSchema.parse({ ok: false, code: "INVALID_SENDER" });
  // Chrome side-panel frames have no tab ID and cannot consume a New Tab handoff.
  const initialSubmit = tabId === undefined ? undefined : await takeInitialSubmit(tabId, chatId);
  if (!initialSubmit)
    return NativeTakeInitialSubmitResponseSchema.parse({
      ok: false,
      code: "INITIAL_SUBMIT_UNAVAILABLE",
    });
  return NativeTakeInitialSubmitResponseSchema.parse({ ok: true, ...initialSubmit });
}

function getOwnSenderUrl(sender: chrome.runtime.MessageSender): URL | undefined {
  if (sender.id !== chrome.runtime.id || !sender.url) return undefined;
  try {
    const url = new URL(sender.url);
    return url.origin === nativeOrigin && (!sender.origin || sender.origin === nativeOrigin)
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

export async function findExistingChat(chatId: string): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => {
    if (!tab.url) return false;
    try {
      const url = new URL(tab.url);
      return url.pathname === "/chat.html" && url.searchParams.get("chatId") === chatId;
    } catch {
      return false;
    }
  });
}

export function chatUrl(chatId: string): string {
  return `${chrome.runtime.getURL("chat.html")}?chatId=${encodeURIComponent(chatId)}`;
}

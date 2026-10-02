import "./completion-notifications.js";
import {
  DevConnectResponseSchema,
  DevExtensionRequestSchema,
  DevOpenChatResponseSchema,
  DevPageGrantResponseSchema,
  DevStoreGrantResponseSchema,
  DevTakeChatGrantResponseSchema,
} from "./dev-extension-message.js";
import { connectDevelopmentClient, type DevConnectionResult } from "./dev-socket.js";

interface PendingChatGrant {
  chatId: string;
  connectionGrant: string;
  createdAt: number;
}

let executorSocket: WebSocket | undefined;
const CONNECTION_GRANT_KEY = "pippin-development-grant";

void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

function toExecutorResponse(result: DevConnectionResult): unknown {
  if (result.kind === "ack") {
    executorSocket?.close();
    executorSocket = result.socket;
    return DevConnectResponseSchema.parse({ ok: true, acknowledgement: result.message });
  }
  if (result.kind === "rejected")
    return DevConnectResponseSchema.parse({ ok: false, code: result.message.code });
  return DevConnectResponseSchema.parse({ ok: false, code: result.code });
}

function isOwnPage(sender: chrome.runtime.MessageSender, path: string): boolean {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  try {
    const received = new URL(sender.url);
    const expected = new URL(chrome.runtime.getURL(path));
    return received.origin === expected.origin && received.pathname === expected.pathname;
  } catch {
    return false;
  }
}

function grantKey(tabId: number): string {
  return `chat-grant-${tabId}`;
}

async function openChat(
  sender: chrome.runtime.MessageSender,
  request: Extract<
    ReturnType<typeof DevExtensionRequestSchema.parse>,
    { kind: "pippin.dev.open-chat" }
  >,
): Promise<unknown> {
  const storedGrant = await getConnectionGrant();
  if (!storedGrant || storedGrant !== request.connectionGrant)
    return DevOpenChatResponseSchema.parse({ ok: false, code: "GRANT_UNAVAILABLE" });
  if (await focusExistingChat(request.chatId))
    return DevOpenChatResponseSchema.parse({ ok: true, focusedExisting: true });
  return createChatTab(sender, request);
}

async function focusExistingChat(chatId: string): Promise<boolean> {
  const existing = await findChatTab(chatId);
  if (existing?.id === undefined) return false;
  await chrome.windows.update(existing.windowId, { focused: true });
  await chrome.tabs.update(existing.id, { active: true });
  return true;
}

async function createChatTab(
  sender: chrome.runtime.MessageSender,
  request: Extract<
    ReturnType<typeof DevExtensionRequestSchema.parse>,
    { kind: "pippin.dev.open-chat" }
  >,
): Promise<unknown> {
  const reuseCurrent =
    request.reuseCurrentTab && (isOwnPage(sender, "home.html") || isOwnPage(sender, "chat.html"));
  const currentTabId = reuseCurrent ? sender.tab?.id : undefined;
  let createdTabId: number | undefined;
  try {
    const tab =
      currentTabId === undefined
        ? await chrome.tabs.create({
            url: "about:blank",
            active: true,
            ...(request.targetWindowId !== undefined ? { windowId: request.targetWindowId } : {}),
          })
        : await chrome.tabs.get(currentTabId);
    if (tab.id === undefined)
      return DevOpenChatResponseSchema.parse({ ok: false, code: "TAB_UNAVAILABLE" });
    if (currentTabId === undefined) createdTabId = tab.id;
    const key = grantKey(tab.id);
    const pending: PendingChatGrant = {
      chatId: request.chatId,
      connectionGrant: request.connectionGrant,
      createdAt: Date.now(),
    };
    await chrome.storage.session.set({ [key]: pending });
    const chatUrl = `${chrome.runtime.getURL("chat.html")}?chatId=${encodeURIComponent(request.chatId)}`;
    await chrome.tabs.update(tab.id, {
      url: chatUrl,
    });
    return DevOpenChatResponseSchema.parse({ ok: true, focusedExisting: false });
  } catch {
    if (createdTabId !== undefined) {
      await chrome.storage.session.remove(grantKey(createdTabId));
      await chrome.tabs.remove(createdTabId).catch(() => undefined);
    }
    return DevOpenChatResponseSchema.parse({ ok: false, code: "TAB_OPEN_FAILED" });
  }
}

function isOpenChatSender(sender: chrome.runtime.MessageSender): boolean {
  return (
    isOwnPage(sender, "options.html") ||
    isOwnPage(sender, "home.html") ||
    isOwnPage(sender, "chat.html") ||
    isOwnPage(sender, "sidepanel.html")
  );
}

function isPageGrantSender(sender: chrome.runtime.MessageSender): boolean {
  return (
    isOwnPage(sender, "viewer.html") ||
    isOwnPage(sender, "home.html") ||
    isOwnPage(sender, "sidepanel.html") ||
    isOwnPage(sender, "chat.html")
  );
}

async function takeChatGrant(
  sender: chrome.runtime.MessageSender,
  requestedChatId: string,
): Promise<unknown> {
  const tabId = sender.tab?.id;
  let url: URL;
  try {
    if (!sender.url) throw new Error("Missing sender URL.");
    url = new URL(sender.url);
    if (url.searchParams.get("chatId") !== requestedChatId) throw new Error("Chat scope mismatch.");
  } catch {
    return DevTakeChatGrantResponseSchema.parse({ ok: false, code: "INVALID_CHAT_PAGE" });
  }
  if (tabId !== undefined) {
    const key = grantKey(tabId);
    const stored = await chrome.storage.session.get(key);
    await chrome.storage.session.remove(key);
    const pending = stored[key] as PendingChatGrant | undefined;
    if (pending && pending.chatId === requestedChatId && Date.now() - pending.createdAt <= 60_000) {
      return DevTakeChatGrantResponseSchema.parse({
        ok: true,
        connectionGrant: pending.connectionGrant,
      });
    }
  }
  const connectionGrant = await getConnectionGrant();
  if (!connectionGrant)
    return DevTakeChatGrantResponseSchema.parse({ ok: false, code: "GRANT_UNAVAILABLE" });
  return DevTakeChatGrantResponseSchema.parse({
    ok: true,
    connectionGrant,
  });
}

async function getConnectionGrant(): Promise<string | undefined> {
  const stored = await chrome.storage.session.get(CONNECTION_GRANT_KEY);
  const value = stored[CONNECTION_GRANT_KEY];
  return typeof value === "string" ? value : undefined;
}

async function findChatTab(chatId: string): Promise<chrome.tabs.Tab | undefined> {
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

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(grantKey(tabId));
});

chrome.windows.onRemoved.addListener((windowId) => {
  void chrome.storage.session.remove(`pippin-selected-chat-${windowId}`);
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) =>
  handleRuntimeMessage(request, sender, sendResponse),
);

function handleRuntimeMessage(
  request: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean | void {
  const parsed = DevExtensionRequestSchema.safeParse(request);
  if (!parsed.success || sender.id !== chrome.runtime.id) return;
  if (handleConnect(parsed.data, sender, sendResponse)) return true;
  if (handleOpenChat(parsed.data, sender, sendResponse)) return true;
  if (handleTakeGrant(parsed.data, sender, sendResponse)) return true;
  if (handlePageGrant(parsed.data, sender, sendResponse)) return true;
  if (handleStoreGrant(parsed.data, sender, sendResponse)) return true;
}

type ExtensionRequest = ReturnType<typeof DevExtensionRequestSchema.parse>;

function handleConnect(
  request: ExtensionRequest,
  sender: chrome.runtime.MessageSender,
  send: (response?: unknown) => void,
): boolean {
  if (request.kind !== "pippin.dev.connect" || !isOwnPage(sender, "options.html")) return false;
  const connectionGrant = request.connectionGrant;
  void chrome.storage.session
    .set({ [CONNECTION_GRANT_KEY]: connectionGrant })
    .then(() => connectDevelopmentClient("extension-executor", connectionGrant))
    .then((result) => send(toExecutorResponse(result)));
  return true;
}

function handleOpenChat(
  request: ExtensionRequest,
  sender: chrome.runtime.MessageSender,
  send: (response?: unknown) => void,
): boolean {
  if (request.kind !== "pippin.dev.open-chat" || !isOpenChatSender(sender)) return false;
  void openChat(sender, request)
    .then(send)
    .catch(() => send(DevOpenChatResponseSchema.parse({ ok: false, code: "TAB_OPEN_FAILED" })));
  return true;
}

function handleTakeGrant(
  request: ExtensionRequest,
  sender: chrome.runtime.MessageSender,
  send: (response?: unknown) => void,
): boolean {
  if (request.kind !== "pippin.dev.take-chat-grant" || !isOwnPage(sender, "chat.html"))
    return false;
  void takeChatGrant(sender, request.chatId).then(send);
  return true;
}

function handlePageGrant(
  request: ExtensionRequest,
  sender: chrome.runtime.MessageSender,
  send: (response?: unknown) => void,
): boolean {
  if (request.kind !== "pippin.dev.get-page-grant") return false;
  if (!isPageGrantSender(sender)) {
    send(DevPageGrantResponseSchema.parse({ ok: false, code: "INVALID_SENDER" }));
    return true;
  }
  void getConnectionGrant().then((connectionGrant) =>
    send(
      connectionGrant
        ? DevPageGrantResponseSchema.parse({ ok: true, connectionGrant })
        : DevPageGrantResponseSchema.parse({ ok: false, code: "GRANT_UNAVAILABLE" }),
    ),
  );
  return true;
}

function handleStoreGrant(
  request: ExtensionRequest,
  sender: chrome.runtime.MessageSender,
  send: (response?: unknown) => void,
): boolean {
  if (request.kind !== "pippin.dev.store-grant" || !isOwnPage(sender, "options.html")) return false;
  void chrome.storage.session
    .set({ [CONNECTION_GRANT_KEY]: request.connectionGrant })
    .then(() => send(DevStoreGrantResponseSchema.parse({ ok: true })))
    .catch(() =>
      send(DevStoreGrantResponseSchema.parse({ ok: false, code: "STORAGE_UNAVAILABLE" })),
    );
  return true;
}

import { mirrorAgentTabView } from "./agent-tab-view.js";
import "./status-favicon.js";
import { PageReconnect } from "./page-reconnect.js";
import { createElement } from "react";
import { ChatIdSchema, DaemonUiRequestSchema, type DaemonUiResponse } from "@aeon/protocol";
import { mountAeonUi, SidePanel, type SidePanelProps } from "@aeon/ui";
import type { UiClient } from "./ui-client-core.js";
import { connectPage, connectionErrorMessage, openExtensionChat } from "./ui-connection.js";
import { handoffKey, pendingHandoffs, saveChatContext } from "./browser-context-storage.js";
import { applyStoredTheme } from "./theme-preferences.js";
import { observePanelFrameTitle } from "./panel-frame-title.js";
import { sidePanelSelectionKey as selectionKey } from "./sidebar-selection.js";

const root = requiredElement("root");
let client: UiClient | undefined;
let windowId: number | undefined;
let chats: Array<{ chatId: string; title: string; updatedAt: string }> = [];
let selectedChatId = "";
let draftProjectId = "";
let pickerOpen = false;
let status = "Loading Chats…";
let updateUi: ((view: ReturnType<typeof createView>) => void) | undefined;
let routingContext = false;
const splitTabs = chrome.tabs as unknown as {
  create(properties: { url: string; windowId?: number; splitWithTabId?: number }): Promise<unknown>;
  createSplit?: (tabIds: [number, number]) => Promise<number>;
  unsplit?: (splitViewId: number) => Promise<void>;
};
const splitViewSupported =
  typeof splitTabs.createSplit === "function" && typeof splitTabs.unsplit === "function";

window.addEventListener("message", (event) => {
  if (
    event.origin !== location.origin ||
    event.source !== document.querySelector<HTMLIFrameElement>("#chat-frame")?.contentWindow
  )
    return;
  if (event.data?.kind === "aeon.new-chat") {
    void selectChat("").then(() => {
      draftProjectId = ChatIdSchema.safeParse(event.data.projectId).success
        ? event.data.projectId
        : "";
      render();
    });
    return;
  }
  if (event.data?.kind !== "aeon.select-chat" || !ChatIdSchema.safeParse(event.data.chatId).success)
    return;
  void refreshChats().then(() => selectChat(event.data.chatId));
});

function createView() {
  const chatUrl = selectedChatId
    ? `${chrome.runtime.getURL("chat.html")}?chatId=${encodeURIComponent(selectedChatId)}&host=panel`
    : chrome.runtime.getURL("home.html") +
      "?host=panel" +
      (draftProjectId ? "&projectId=" + encodeURIComponent(draftProjectId) : "");
  const props: SidePanelProps = {
    chats,
    selectedChatId,
    status,
    pickerOpen,
    chatFrameSrc: chatUrl,
    splitViewSupported,
    onTogglePicker: (open) => setPickerOpen(open),
    onSelect: (chatId) => void selectChat(chatId),
    onNew: () => void selectChat(""),
    onAllChats: () => void openAllChats(),
    onOpenFull: () => void openSelectedChat(),
    onOpenSplit: () => void openSelectedInSplitView(),
  };
  return createElement(SidePanel, props);
}

function render(): void {
  if (updateUi) updateUi(createView());
  else updateUi = mountAeonUi(root, createView());
}
function setPickerOpen(open: boolean): void {
  pickerOpen = open;
  render();
}

const stopObservingTitle = observePanelFrameTitle(
  root,
  () => selectedChatId,
  (chatId, title) => {
    const chat = chats.find((item) => item.chatId === chatId);
    if (!chat || chat.title === title) return;
    chat.title = title;
    render();
  },
);
window.addEventListener("pagehide", stopObservingTitle, { once: true });
render();
void applyStoredTheme();
const reconnect = new PageReconnect(start, (message) => {
  status = message;
  render();
});
void reconnect.start();
window.addEventListener("pagehide", () => client?.close(), { once: true });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session") return;
  void routePendingContext();
  // Another surface (the orb's Open chat) chose the chat this window's panel shows.
  const chosen = windowId === undefined ? undefined : changes[selectionKey(windowId)]?.newValue;
  if (typeof chosen === "string" && chosen !== selectedChatId && client)
    void refreshChats().then(() => selectChat(chosen, false));
});

async function start(): Promise<void> {
  status = "Connecting to the local daemon…";
  try {
    const currentWindow = await chrome.windows.getCurrent();
    if (currentWindow.id === undefined) throw new Error("The browser window is unavailable.");
    windowId = currentWindow.id;
    const connection = await connectPage({ kind: "catalog" });
    if (connection.kind !== "connected") throw new Error(connectionErrorMessage(connection.code));
    client = connection.client;
    reconnect.watch(client);
    client.subscribe(handleDaemonMessage);
    const stored = await chrome.storage.session.get(selectionKey(windowId));
    const savedId = stored[selectionKey(windowId)];
    await refreshChats();
    status = "";
    if (typeof savedId === "string" && chats.some((chat) => chat.chatId === savedId))
      await selectChat(savedId, false);
    else {
      selectedChatId = "";
      render();
    }
    await routePendingContext();
    if (!selectedChatId) render();
  } catch (error) {
    status = `Aeon is unavailable · ${messageOf(error)}`;
    render();
    throw error;
  }
}

async function refreshChats(): Promise<void> {
  const connected = requireClient();
  const requestId = crypto.randomUUID();
  const after = connected.send(
    DaemonUiRequestSchema.parse({
      kind: "command",
      requestId,
      operation: "chat.list",
      payload: { limit: 100 },
    }),
  );
  const response = await connected.waitFor(
    (message) =>
      (message.kind === "command.completed" || message.kind === "command.failed") &&
      message.requestId === requestId,
    after,
  );
  if (response.kind !== "command.completed" || response.result.kind !== "chat.listed")
    throw new Error(response.kind === "command.failed" ? response.message : "INVALID_CHAT_LIST");
  chats = response.result.chats.map(({ chatId, title, updatedAt }) => ({
    chatId,
    title,
    updatedAt,
  }));
  render();
  if (selectedChatId && !chats.some((chat) => chat.chatId === selectedChatId))
    await selectChat("", false);
}

async function selectChat(candidate: string, persist = true): Promise<void> {
  draftProjectId = "";
  const parsed = ChatIdSchema.safeParse(candidate);
  if (!parsed.success || !chats.some((chat) => chat.chatId === parsed.data)) {
    selectedChatId = "";
    if (persist && windowId !== undefined)
      await chrome.storage.session.remove(selectionKey(windowId));
    setPickerOpen(false);
    return;
  }
  selectedChatId = parsed.data;
  setPickerOpen(false);
  if (persist && windowId !== undefined)
    await chrome.storage.session.set({ [selectionKey(windowId)]: selectedChatId });
  render();
}

async function createChat(): Promise<void> {
  try {
    const connected = requireClient();
    const requestId = crypto.randomUUID();
    const after = connected.send(
      DaemonUiRequestSchema.parse({
        kind: "command",
        requestId,
        operation: "chat.create",
        payload: { title: "New Chat" },
      }),
    );
    const response = await connected.waitFor(
      (message) =>
        (message.kind === "command.completed" || message.kind === "command.failed") &&
        message.requestId === requestId,
      after,
    );
    if (response.kind !== "command.completed" || response.result.kind !== "chat.created")
      throw new Error(
        response.kind === "command.failed" ? response.message : "INVALID_CREATE_RESPONSE",
      );
    await refreshChats();
    await selectChat(response.result.chat.chatId);
  } catch (error) {
    status = `Could not create Chat · ${messageOf(error)}`;
    render();
  }
}

async function routePendingContext(): Promise<void> {
  if (routingContext || windowId === undefined || !client) return;
  routingContext = true;
  try {
    while (true) {
      const pending = await pendingHandoffs(windowId);
      if (!pending.length) return;
      if (!selectedChatId) await createChat();
      const targetChatId = selectedChatId;
      if (!targetChatId) return;
      for (const handoff of pending) {
        await saveChatContext(targetChatId, handoff);
        await chrome.storage.session.remove(handoffKey(handoff.invocationId));
      }
    }
  } catch (error) {
    status = `Could not attach page context · ${messageOf(error)}`;
    render();
  } finally {
    routingContext = false;
  }
}

async function openSelectedChat(): Promise<void> {
  if (!selectedChatId) return;
  try {
    await openExtensionChat(selectedChatId, {
      ...(windowId !== undefined ? { targetWindowId: windowId } : {}),
    });
    await closePanel();
  } catch (error) {
    status = `Could not open this Chat · ${messageOf(error)}`;
  }
  render();
}

async function openSelectedInSplitView(): Promise<void> {
  if (!selectedChatId || windowId === undefined) return;
  const url = `${chrome.runtime.getURL("chat.html")}?chatId=${encodeURIComponent(selectedChatId)}`;
  const active = (await chrome.tabs.query({ active: true, windowId }))[0];
  try {
    if (!splitViewSupported || active?.id === undefined)
      throw new Error("Split View requires Chrome 155 and an active tab.");
    await splitTabs.create({ url, windowId, splitWithTabId: active.id });
    status = "";
  } catch {
    await chrome.tabs.create({ url, windowId });
    status = splitViewSupported
      ? "Chrome couldn’t pair these tabs. Chat opened in a new tab."
      : "Split View requires Chrome 155+. Chat opened in a new tab.";
  }
  await closePanel();
  render();
}

async function openAllChats(): Promise<void> {
  setPickerOpen(false);
  await chrome.tabs.create({ url: `${chrome.runtime.getURL("home.html")}?view=chats` });
  await closePanel();
}
function handleDaemonMessage(message: DaemonUiResponse): void {
  if (
    message.kind === "chat.event" &&
    message.chatId === selectedChatId &&
    message.event.event.kind === "chat-metadata"
  )
    void refreshChats();
}
function requireClient(): UiClient {
  if (!client) throw new Error("The local daemon is unavailable.");
  return client;
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "LOCAL_ERROR";
}
function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing side-panel root: ${id}`);
  return element;
}

async function closePanel(): Promise<void> {
  const panel = chrome.sidePanel as unknown as {
    close?: (options: { windowId: number }) => Promise<void>;
  };
  if (windowId !== undefined && panel.close) await panel.close({ windowId });
  else window.close();
}

mirrorAgentTabView();

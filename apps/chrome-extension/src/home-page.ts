import { saveInitialDisplay } from "./initial-chat-display.js";
import "./status-favicon.js";
import { PageReconnect } from "./page-reconnect.js";
import { projectDraftPayload } from "./project-bridge.js";
import { openNewChat } from "./new-chat-navigation.js";
import { createElement } from "react";
import {
  type ChatCatalogItemDto,
  type DaemonUiResponse,
  type PiModelCatalogDto,
  PiModelCatalogSchema,
  PiAttachmentSchema,
  type PiAttachmentDto,
} from "@pippin/protocol";
import { mountPippinUi, NewTabHome, type ComposerModel, type ComposerAttachment } from "@pippin/ui";
import { readComposerAttachment } from "./chat-composer-attachments.js";
import { applyStoredTheme } from "./theme-preferences.js";
import type { DevUiClient } from "./dev-ui-client.js";
import { connectPage, connectionErrorMessage, openExtensionChat } from "./ui-connection.js";
import { HomeCatalogController } from "./home-catalog-controller.js";
import { HomeManagementController } from "./home-management-controller.js";
import { createManagementClient } from "./management-client.js";
import { applyInitialChatSelection } from "./initial-chat-selection.js";

const root = requiredElement("root");
if (new URL(location.href).searchParams.get("host") === "panel")
  document.body.dataset.host = "panel";
void applyStoredTheme();
let client: DevUiClient | undefined;
let connectionGrant = "";
let chats: ChatCatalogItemDto[] = [];
let modelCatalog: PiModelCatalogDto | null = null;
let connectionLabel = "Starting";
let errorMessage = "";
let openChatIds: ReadonlySet<string> = new Set();
let updateUi: ((view: ReturnType<typeof createView>) => void) | undefined;
const catalog = new HomeCatalogController({
  client: () => client,
  onError: showError,
  onClearError: clearError,
  onChange: render,
  refreshHome,
});
const management = new HomeManagementController(
  () => client,
  () => render(),
  (chatId) => void openChat(chatId),
  createManagementClient(__PIPPIN_NATIVE_TRANSPORT__, () => client),
);

function createView() {
  return createElement(NewTabHome, {
    developmentFixture: !__PIPPIN_NATIVE_TRANSPORT__,
    connectionLabel,
    chats,
    modelCatalog,
    openChatIds,
    catalogOpen: catalog.open,
    catalogQuery: catalog.query,
    includeArchived: catalog.includeArchived,
    catalogResults: catalog.results,
    catalogPending: catalog.pending,
    searchWarnings: catalog.searchWarnings,
    error: errorMessage,
    onAsk: (
      query: string,
      model: ComposerModel,
      thinkingLevel: string,
      attachments?: readonly ComposerAttachment[],
    ) => void askPippin(query, model, thinkingLevel, attachments),
    onReadAttachments: (files: readonly File[]) => Promise.all(files.map(readComposerAttachment)),
    onNewChat: openNewChat,
    onOpenChat: (chatId: string) => void openChat(chatId),
    onCatalog: () => catalog.show(),
    onCatalogQuery: (query: string) => catalog.setQuery(query),
    onIncludeArchived: (include: boolean) => catalog.setIncludeArchived(include),
    onPin: (chat: ChatCatalogItemDto) => void catalog.togglePinned(chat),
    onArchive: (chat: ChatCatalogItemDto) => void catalog.toggleArchived(chat),
    onDelete: (chat: ChatCatalogItemDto) => void catalog.deleteChat(chat),
    onRename: (chat: ChatCatalogItemDto) => void catalog.rename(chat),
    ...management.viewProps(),
  });
}

function render(): void {
  if (updateUi) updateUi(createView());
  else updateUi = mountPippinUi(root, createView());
}

if (new URL(location.href).searchParams.get("embedded") === "1")
  document.body.dataset.embedded = "true";
render();
void restoreModelCatalog();
const reconnect = new PageReconnect(start, (message) => {
  connectionLabel = "Reconnecting";
  showError(message);
});
void reconnect.start();
window.addEventListener("pagehide", () => client?.close(), { once: true });

async function start(): Promise<void> {
  const result = await connectPage({ kind: "catalog" });
  if (result.kind !== "connected") {
    throw new Error(connectionErrorMessage(result.code));
  }
  client = result.client;
  reconnect.watch(client);
  errorMessage = "";
  connectionGrant = result.developmentGrant;
  connectionLabel = "Connected";
  render();
  await Promise.all([
    management.readPreferences(),
    refreshHome(),
    loadModelCatalog(),
    management.loadForHome(),
  ]);
  const selectedChat = new URL(location.href).searchParams.get("chatId");
  if (selectedChat) management.viewProps().onManagementSelectChat(selectedChat);
  if (new URL(location.href).searchParams.get("view") === "chats") catalog.show();
}

async function refreshHome(): Promise<void> {
  const listed = await catalog.listChats(100, "", false);
  if (!listed) return;
  chats = listed;
  openChatIds = await getOpenChatIds();
  render();
}

async function askPippin(
  text: string,
  model: ComposerModel,
  thinkingLevel: string,
  attachments: readonly ComposerAttachment[] = [],
): Promise<void> {
  const activeClient = client;
  if (!activeClient || !text) return;
  try {
    const files = attachments.map((file) => PiAttachmentSchema.parse(file));
    const createId = crypto.randomUUID();
    const createAfter = activeClient.send({
      kind: "command",
      requestId: createId,
      operation: "chat.create",
      payload: projectDraftPayload(),
    });
    const created = await activeClient.waitFor(isCommandResponse(createId), createAfter);
    if (created.kind === "command.failed") throw new Error(created.message);
    if (created.kind !== "command.completed" || created.result.kind !== "chat.created")
      throw new Error("Unexpected Chat creation response.");
    const chatId = created.result.chat.chatId;
    saveInitialDisplay(chatId, { text, model, thinkingLevel });
    if (
      __PIPPIN_NATIVE_TRANSPORT__ &&
      new URL(location.href).searchParams.get("host") !== "panel"
    ) {
      await openChatInCurrentTab(chatId, {
        requestId: crypto.randomUUID(),
        text,
        model: { provider: model.provider, id: model.id },
        thinkingLevel,
        attachments: files,
      });
      return;
    }
    await applyInitialChatSelection(activeClient, chatId, {
      model: { provider: model.provider, id: model.id },
      thinkingLevel,
    });
    const submitId = crypto.randomUUID();
    const submitAfter = activeClient.send({
      kind: "command",
      requestId: submitId,
      operation: "chat.submit",
      payload: { chatId, text, attachments: files },
    });
    const started = await activeClient.waitFor(
      (message) => message.kind === "command.started" && message.requestId === submitId,
      submitAfter,
    );
    if (started.kind !== "command.started")
      throw new Error("Pi did not start the first Chat prompt.");
    await openChatInCurrentTab(chatId);
  } catch (error) {
    showError(toMessage(error));
  }
}

async function openChat(chatId: string): Promise<void> {
  try {
    await openChatInCurrentTab(chatId);
  } catch (error) {
    showError(toMessage(error));
  }
}
async function openChatInCurrentTab(
  chatId: string,
  initialSubmit?: {
    requestId: string;
    text: string;
    model: { provider: string; id: string };
    thinkingLevel: string;
    attachments?: PiAttachmentDto[];
  },
): Promise<void> {
  if (new URL(location.href).searchParams.get("host") === "panel") {
    window.parent.postMessage({ kind: "pippin.select-chat", chatId }, location.origin);
    location.assign(
      chrome.runtime.getURL("chat.html") + "?chatId=" + encodeURIComponent(chatId) + "&host=panel",
    );
    return;
  }
  await requestOpenChat(chatId, true, initialSubmit);
}
async function requestOpenChat(
  chatId: string,
  reuseCurrentTab: boolean,
  initialSubmit?: {
    requestId: string;
    text: string;
    model: { provider: string; id: string };
    thinkingLevel: string;
    attachments?: PiAttachmentDto[];
  },
): Promise<void> {
  await openExtensionChat(
    chatId,
    {
      ...(reuseCurrentTab ? { reuseCurrentTab: true } : {}),
      ...(initialSubmit ? { initialSubmit } : {}),
    },
    connectionGrant,
  );
}

async function loadModelCatalog(): Promise<void> {
  const activeClient = client;
  if (!activeClient) return;
  try {
    const requestId = crypto.randomUUID();
    const after = activeClient.send({
      kind: "command",
      requestId,
      operation: "chat.model-catalog",
      payload: {},
    });
    const response = await activeClient.waitFor(isCommandResponse(requestId), after);
    if (response.kind === "command.failed") throw new Error(response.message);
    if (response.kind !== "command.completed" || response.result.kind !== "chat.model-catalog")
      throw new Error("Pi did not return its model catalog.");
    modelCatalog = response.result.catalog;
    void chrome.storage.local.set({ pippinModelCatalog: modelCatalog });
    render();
  } catch (error) {
    showError(`Pi model settings unavailable · ${toMessage(error)}`);
  }
}

async function getOpenChatIds(): Promise<Set<string>> {
  const tabs = await chrome.tabs.query({});
  const ids = new Set<string>();
  for (const tab of tabs) {
    if (!tab.url) continue;
    try {
      const url = new URL(tab.url);
      if (url.pathname === "/chat.html") {
        const chatId = url.searchParams.get("chatId");
        if (chatId) ids.add(chatId);
      }
    } catch {
      /* Non-extension tabs are not Chat views. */
    }
  }
  return ids;
}

function isCommandResponse(requestId: string) {
  return (
    message: DaemonUiResponse,
  ): message is Extract<DaemonUiResponse, { kind: "command.completed" | "command.failed" }> =>
    (message.kind === "command.completed" || message.kind === "command.failed") &&
    message.requestId === requestId;
}
function showError(message: string): void {
  errorMessage = message;
  render();
}
function clearError(): void {
  errorMessage = "";
  render();
}
function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The local Chat command could not complete.";
}
function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing New Tab root: ${id}`);
  return element;
}

async function restoreModelCatalog(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get("pippinModelCatalog");
    if (!modelCatalog && stored.pippinModelCatalog) {
      const parsed = PiModelCatalogSchema.safeParse(stored.pippinModelCatalog);
      if (parsed.success) {
        modelCatalog = parsed.data;
        render();
      }
    }
  } catch {
    /* Fresh daemon catalog remains authoritative. */
  }
}

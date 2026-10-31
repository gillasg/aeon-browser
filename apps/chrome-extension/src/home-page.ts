import { installLinkBanner } from "./link-banner.js";
import { mirrorAgentTabView } from "./agent-tab-view.js";
import { savePanelContext } from "./panel-prompt-handoff.js";
import { startHomePrompt } from "./home-first-submit.js";
import { saveInitialDisplay } from "./initial-chat-display.js";
import "./status-favicon.js";
import { PageReconnect } from "./page-reconnect.js";
import { openNewChat } from "./new-chat-navigation.js";
import { createElement } from "react";
import {
  type ChatCatalogItemDto,
  type DaemonUiResponse,
  type PiModelCatalogDto,
  PiModelCatalogSchema,
  PiAttachmentSchema,
  type PiAttachmentDto,
} from "@aeon/protocol";
import {
  mountAeonUi,
  NewTabHome,
  type ComposerModel,
  type ComposerAttachment,
  type HomeRunPreview,
} from "@aeon/ui";
import { followHomePreviews } from "./home-previews.js";
import { followHomeRunActions } from "./home-run-actions.js";
import { followPrivacy } from "./home-privacy.js";
import { markActivityUndone, type ActivityEntry } from "@aeon/ui";
import { readComposerAttachment } from "./chat-composer-attachments.js";
import { sendComposerCommand } from "./composer-command.js";
import { ModelSignIn } from "./model-sign-in.js";
import { HomeModelAccounts } from "./home-model-accounts.js";
import { applyStoredTheme } from "./theme-preferences.js";
import type { UiClient } from "./ui-client-core.js";
import { connectPage, connectionErrorMessage, openExtensionChat } from "./ui-connection.js";
import { HomeCatalogController } from "./home-catalog-controller.js";
import { HomeBlockedSites } from "./home-blocked-sites.js";
import { HomeFormProfile } from "./home-form-profile.js";
import { HomeOutsideContext } from "./home-outside-context.js";
import { HomeManagementController } from "./home-management-controller.js";
import { createManagementClient } from "./management-client.js";

const root = requiredElement("root");
if (new URL(location.href).searchParams.get("host") === "panel")
  document.body.dataset.host = "panel";
void applyStoredTheme();
let client: UiClient | undefined;
const privacy = followPrivacy(() => render());
const runActions = followHomeRunActions({
  client: () => client,
  onChange: () => render(),
});
let chats: ChatCatalogItemDto[] = [];
let modelCatalog: PiModelCatalogDto | null = null;
let connectionLabel = "Starting";
let errorMessage = "";
let openChatIds: ReadonlySet<string> = new Set();
let runningChatIds: ReadonlySet<string> = new Set();
let needsChatIds: ReadonlySet<string> = new Set();
let previews: ReadonlyMap<string, HomeRunPreview> = new Map();
let updateUi: ((view: ReturnType<typeof createView>) => void) | undefined;
const modelSignIn = new ModelSignIn(
  async () => {
    await loadModelCatalog();
    return Boolean(modelCatalog?.models.length);
  },
  () => render(),
);
const modelAccounts = new HomeModelAccounts(
  (request) => sendComposerCommand(client, request),
  () => render(),
  () => void loadModelCatalog(),
);
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
  createManagementClient(__AEON_NATIVE_TRANSPORT__, () => client),
);
const blockedSites = new HomeBlockedSites({
  client: () => client,
  onChange: render,
  onError: showError,
});
const formProfile = new HomeFormProfile({
  client: () => client,
  onChange: render,
  onError: showError,
});
const outsideContext = new HomeOutsideContext({
  client: () => client,
  onChange: render,
  onError: showError,
});

/** Reverses an API write from Activity, one item at a time, through its learned reverse. */
async function undoActivity(entry: ActivityEntry): Promise<void> {
  const undo = entry.undo;
  if (!undo) return;
  try {
    for (const params of undo.params) {
      const reply = (await chrome.runtime.sendMessage({
        kind: "aeon.site.undo",
        site: undo.site,
        operation: undo.operation,
        params,
      })) as { ok?: boolean; error?: string } | undefined;
      if (!reply?.ok) throw new Error(reply?.error ?? "The site refused the change");
    }
    markActivityUndone(entry.id);
  } catch (error) {
    markActivityUndone(entry.id, error instanceof Error ? error.message : String(error));
  }
}

function createView() {
  return createElement(NewTabHome, {
    developmentFixture: !__AEON_NATIVE_TRANSPORT__,
    connectionLabel,
    connected: client?.socket.readyState === WebSocket.OPEN && connectionLabel === "Connected",
    chats,
    runningChatIds,
    needsChatIds,
    previews,
    runActions: runActions(),
    modelCatalog,
    modelLogin: modelSignIn.state,
    onConnectModel: () => void modelSignIn.open(),
    modelAccounts: modelAccounts.viewProps(),
    openChatIds,
    catalogOpen: catalog.open,
    catalogQuery: catalog.query,
    includeArchived: catalog.includeArchived,
    catalogResults: catalog.results,
    catalogPending: catalog.pending,
    searchWarnings: catalog.searchWarnings,
    error: errorMessage,
    onDismissError: clearError,
    onAsk: (
      query: string,
      model: ComposerModel,
      thinkingLevel: string,
      attachments?: readonly ComposerAttachment[],
    ) => void askAeon(query, model, thinkingLevel, attachments),
    onReadAttachments: (files: readonly File[]) => Promise.all(files.map(readComposerAttachment)),
    onNewChat: () => openNewChat(),
    onOpenChat: (chatId: string) => void openChat(chatId),
    onUndoActivity: (entry: ActivityEntry) => void undoActivity(entry),
    onCatalog: () => catalog.show(),
    onCloseCatalog: () => catalog.hide(),
    onCatalogQuery: (query: string) => catalog.setQuery(query),
    onIncludeArchived: (include: boolean) => catalog.setIncludeArchived(include),
    onPin: (chat: ChatCatalogItemDto) => void catalog.togglePinned(chat),
    onArchive: (chat: ChatCatalogItemDto) => void catalog.toggleArchived(chat),
    onDelete: (chat: ChatCatalogItemDto) => void catalog.deleteChat(chat),
    onRename: (chat: ChatCatalogItemDto) => void catalog.rename(chat),
    blockedSites: blockedSites.sites,
    onBlockedSiteAdd: (site: string) => void blockedSites.add(site),
    onBlockedSiteRemove: (site: string) => void blockedSites.remove(site),
    formProfile: formProfile.fields,
    ...(formProfile.refused ? { formProfileRefused: formProfile.refused } : {}),
    onFormFieldSave: (field: string, value: string) => void formProfile.save(field, value),
    onFormFieldRemove: (field: string) => void formProfile.remove(field),
    outsideContext: outsideContext.enabled,
    privacy: privacy(),
    onOutsideContext: (enabled: boolean) => void outsideContext.set(enabled),
    ...management.viewProps(),
  });
}

function render(): void {
  if (updateUi) updateUi(createView());
  else updateUi = mountAeonUi(root, createView());
}

if (new URL(location.href).searchParams.get("embedded") === "1")
  document.body.dataset.embedded = "true";
render();
void restoreModelCatalog();
void watchRunningChats();
followHomePreviews((next) => {
  previews = next;
  render();
});
const reconnect = new PageReconnect(start, (message) => {
  connectionLabel = "Reconnecting";
  showError(message);
});
void reconnect.start();
window.addEventListener("focus", () => {
  if (client?.socket.readyState === WebSocket.OPEN) void refreshHome();
});
window.addEventListener("pagehide", () => client?.close(), { once: true });

async function start(): Promise<void> {
  const result = await connectPage({ kind: "catalog" });
  if (result.kind !== "connected") {
    throw new Error(connectionErrorMessage(result.code));
  }
  client = result.client;
  reconnect.watch(client);
  errorMessage = "";
  connectionLabel = "Connected";
  render();
  modelAccounts.refresh();
  await Promise.all([
    management.readPreferences(),
    refreshHome(),
    loadModelCatalog(),
    management.loadForHome(),
    blockedSites.load(),
    formProfile.load(),
    outsideContext.load(),
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

async function askAeon(
  text: string,
  model: ComposerModel,
  thinkingLevel: string,
  attachments: readonly ComposerAttachment[] = [],
): Promise<void> {
  const activeClient = client;
  if (!activeClient || !text) return;
  try {
    const files = attachments.map((file) => PiAttachmentSchema.parse(file));
    const chatId = await startHomePrompt(activeClient, {
      text,
      model: { provider: model.provider, id: model.id },
      thinkingLevel,
      attachments: files,
    });
    saveInitialDisplay(chatId, { text, model, thinkingLevel });
    if (document.body.dataset.host === "panel") await savePanelContext(chatId);
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
    window.parent.postMessage({ kind: "aeon.select-chat", chatId }, location.origin);

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
  await openExtensionChat(chatId, {
    ...(reuseCurrentTab ? { reuseCurrentTab: true } : {}),
    ...(initialSubmit ? { initialSubmit } : {}),
  });
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
    void chrome.storage.local.set({ aeonModelCatalog: modelCatalog });
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

// The worker mirrors each chat's working state into session storage (completion-notifications);
// orbs record the chat that is waiting for the user (orb-control).
const WORKING_PREFIX = "aeon-chat-working-";
const NEEDS_PREFIX = "aeon-orb-needs:";
async function watchRunningChats(): Promise<void> {
  const read = async () => {
    const values = await chrome.storage.session.get(null);
    runningChatIds = new Set(
      Object.entries(values)
        .filter(([key, value]) => key.startsWith(WORKING_PREFIX) && value === "working")
        .map(([key]) => key.slice(WORKING_PREFIX.length)),
    );
    needsChatIds = new Set(
      Object.entries(values)
        .filter(([key, value]) => key.startsWith(NEEDS_PREFIX) && typeof value === "string")
        .map(([, value]) => value as string),
    );
    render();
  };
  chrome.storage.session.onChanged.addListener((changes) => {
    if (
      Object.keys(changes).some((key) =>
        [WORKING_PREFIX, NEEDS_PREFIX].some((p) => key.startsWith(p)),
      )
    )
      void read();
  });
  await read().catch(() => undefined);
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
    const stored = await chrome.storage.local.get("aeonModelCatalog");
    if (!modelCatalog && stored.aeonModelCatalog) {
      const parsed = PiModelCatalogSchema.safeParse(stored.aeonModelCatalog);
      if (parsed.success) {
        modelCatalog = parsed.data;
        render();
      }
    }
  } catch {
    /* Fresh daemon catalog remains authoritative. */
  }
}

mirrorAgentTabView();

installLinkBanner();

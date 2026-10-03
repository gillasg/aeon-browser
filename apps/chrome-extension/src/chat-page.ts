import { InitialChatDisplay } from "./initial-chat-display.js";
import { observeChatTabStatus } from "./chat-tab-status.js";
import { subscribeSavedChat } from "./chat-subscribe-client.js";
import "./project-bridge.js";
import { installFileViewerLinks } from "./file-viewer-launch.js";
import { openNewChat } from "./new-chat-navigation.js";
import { createElement } from "react";
import { createToolImageLoader } from "./tool-image-client.js";
import { ChatIdSchema, type ChatViewSnapshotDto, type DaemonUiResponse } from "@pippin/protocol";
import { ChatSurface, mountPippinUi, TranscriptModel } from "@pippin/ui";
import type { DevUiClient } from "./dev-ui-client.js";
import {
  connectCatalogPage,
  connectPage,
  connectionErrorMessage,
  openExtensionChat,
} from "./ui-connection.js";
import { submitInitialPrompt } from "./chat-initial-submit.js";
import { ChatSidebarController } from "./chat-sidebar-controller.js";
import { ChatComposerController } from "./chat-composer-controller.js";
import {
  readChatContext,
  removeChatContext,
  subscribeChatContextDraft,
  updateContextStatus,
} from "./browser-context-storage.js";
import { createBrowserContextDraftHandler } from "./chat-browser-context-draft.js";
import {
  chatPageErrorMessage as errorMessage,
  createChatPageCloser,
  requiredChatPageElement as requiredElement,
} from "./chat-page-lifecycle.js";
import { ChatResourcesController } from "./chat-resources-controller.js";
import { initializeChatPreferences } from "./chat-preferences.js";
import { ChatPiUiController } from "./chat-pi-ui-controller.js";
const root = requiredElement("root");
const chatIdResult = ChatIdSchema.safeParse(new URL(location.href).searchParams.get("chatId"));
const chatId = chatIdResult.success ? chatIdResult.data : "";
const initialDisplay = new InitialChatDisplay(chatId);
if (new URL(location.href).searchParams.get("host") === "panel")
  document.body.dataset.host = "panel";
let connectionGrant = "";
let client: DevUiClient | undefined;
const fetchToolImage = createToolImageLoader(() => client, chatId);
let catalogClient: DevUiClient | undefined;
let subscriptionId = "";
let cursor: { epoch: string; revision: number } | undefined;
let runState: "idle" | "running-unconfirmed" | "uncertain" | "needs_attention" = "idle";
let contextUsage: ChatViewSnapshotDto["contextUsage"] = null;
let reconnectTimer = 0;
let reconnectAttempt = 0;
let isClosing = false;
let connection: { label: string; state: "connecting" | "connected" | "error" } = {
  label: "Connecting",
  state: "connecting",
};
let notice = chatId ? "" : "This Chat link does not include a valid Chat ID.";
let title = "Chat · Aeon";
const pendingSubmits = new Set<string>();
const attemptedContextSubmits = new Set<string>();
let initialSubmitAttempted = false;
const transcript = new TranscriptModel();
let updateUi: (view: ReturnType<typeof createView>) => void;
const resources = new ChatResourcesController(chatId, () => render());
const sidebar = new ChatSidebarController({
  currentChatId: chatId,
  client: () => catalogClient,
  openChat: async (nextChatId) => {
    await openExtensionChat(nextChatId, { reuseCurrentTab: true }, connectionGrant);
  },
  onChange: () => render(),
  onError: showError,
});
const composer = new ChatComposerController(
  chatId,
  () =>
    runState === "running-unconfirmed" || runState === "needs_attention" || pendingSubmits.size > 0,
  () => render(),
  showError,
  (contextId) => void removeChatContext(chatId, contextId),
  (contextId, status) => updateContextStatus(chatId, contextId, status),
);
const piUi = new ChatPiUiController(
  chatId,
  () => render(),
  (snapshot, nextCursor) => applySnapshot(snapshot, nextCursor, subscriptionId),
  (text, attachments, notice) => composer.loadEditDraft(text, attachments, notice),
  async (forkedChatId) => {
    await openExtensionChat(forkedChatId, {}, connectionGrant);
  },
  showError,
);
const applyBrowserContextDraft = createBrowserContextDraftHandler({
  chatId,
  composer,
  nativeTransport: __PIPPIN_NATIVE_TRANSPORT__,
  attemptedInvocations: attemptedContextSubmits,
  showError,
  readRuntimeState: () => ({
    connected: connection.state === "connected",
    running: runState === "running-unconfirmed",
    hasPendingSubmits: pendingSubmits.size > 0,
  }),
});
function createView() {
  return createElement(ChatSurface, {
    developmentFixture: !__PIPPIN_NATIVE_TRANSPORT__,
    chatId,
    title,
    connection,
    notice,
    rows: initialDisplay.rows(transcript.rows),
    loadToolImage: fetchToolImage,
    transcriptActionsDisabled: runState !== "idle",
    chats: sidebar.chats,
    sidebarOpen: sidebar.open,
    sidebarQuery: sidebar.query,
    composer: { ...composer.props(), controls: initialDisplay.controls(composer.props().controls), contextUsage, ...piUi.composerProps() },
    ...resources.viewProps(),
    ...piUi.viewProps(),
    onToggleSidebar: () => sidebar.setOpen(!sidebar.open),
    onCloseSidebar: () => sidebar.setOpen(false),
    onSidebarQuery: (value: string) => sidebar.setQuery(value),
    onSelectChat: (nextChatId: string) => void sidebar.openChat(nextChatId),
    ...sidebar.actionProps(),
    onNewChat: openNewChat,
  });
}
function render(): void {
  if (updateUi) updateUi(createView());
  else updateUi = mountPippinUi(root, createView());
}
installFileViewerLinks(chatId);
render();
void initializeChatPreferences(sidebar, document.body.dataset.host === "panel");
if (notice) showError(notice);
const onStorageChanged = subscribeChatContextDraft(chatId, applyBrowserContextDraft);
const closeView = createChatPageCloser(() => ({
  chatId,
  subscriptionId,
  reconnectTimer,
  client,
  catalogClient,
  composer,
  onStorageChanged,
  markClosing: () => {
    isClosing = true;
  },
}));
window.addEventListener("pagehide", closeView, { once: true });
window.addEventListener("pagehide", () => piUi.close(), { once: true });
if (chatId) void start();
async function start(): Promise<void> {
  try {
    await connectAndSubscribe();
  } catch (error) {
    showError(errorMessage(error));
    setConnection("Disconnected", "error");
  }
}
async function connectAndSubscribe(): Promise<void> {
  if (isClosing || !chatId) return;
  void connectCatalogPage(catalogClient).then((value) => { catalogClient = value; }).catch(showError);
  const result = await connectPage({ kind: "chat", chatId });
  if (result.kind !== "connected") {
    setConnection("Disconnected", "error");
    showError(connectionErrorMessage(result.code));
    scheduleReconnect();
    return;
  }
  connectionGrant = result.developmentGrant;
  client = result.client;
  resources.setClient(client);
  composer.setClient(client);
  reconnectAttempt = 0;
  attachChatClientListeners(result.client);
  notice = "";
  setConnection("Connected", "connected");
  try {
    const response = await subscribeSavedChat(client, chatId, cursor ?? undefined);
    if (response.kind === "chat.subscription-failed") {
      showError(`${response.code} · ${response.message}`);
      return;
    }
    if (response.kind === "chat.snapshot")
      applySnapshot(response.snapshot, response.cursor, response.subscriptionId);
    if (response.kind === "chat.resumed") subscriptionId = response.subscriptionId;
    piUi.setClient(client);
    await submitFirstPrompt();
    await applyBrowserContextDraft(await readChatContext(chatId));
    if (resources.open) void resources.refresh();
  } catch (error) {
    showError(errorMessage(error));
  }
}
function attachChatClientListeners(activeClient: DevUiClient): void {
  observeChatTabStatus(activeClient, chatId);
  activeClient.subscribe(handleDaemonMessage);
  activeClient.socket.addEventListener(
    "close",
    () => {
      if (isClosing || client?.socket !== activeClient.socket) return;
      resources.markDisconnected();
      setConnection("Disconnected", "error");
      showError("Connection lost · trying to reconnect");
      scheduleReconnect();
    },
    { once: true },
  );
}
async function submitFirstPrompt(): Promise<void> {
  if (!__PIPPIN_NATIVE_TRANSPORT__ || initialSubmitAttempted || !client) return;
  initialSubmitAttempted = true;
  await submitInitialPrompt(chatId, client, __PIPPIN_NATIVE_TRANSPORT__);
  void composer.refreshControls();
}
function handleDaemonMessage(message: DaemonUiResponse): void {
  if (message.kind === "chat.snapshot") {
    if (message.snapshot.chat.chatId === chatId)
      applySnapshot(message.snapshot, message.cursor, message.subscriptionId);
    return;
  }
  if (message.kind === "chat.resumed") {
    subscriptionId = message.subscriptionId;
    return;
  }
  if (message.kind === "chat.event") {
    handleChatEvent(message);
    return;
  }
  if (message.kind === "command.started" && message.chatId === chatId) {
    pendingSubmits.add(message.requestId);
    runState = "running-unconfirmed";
    render();
    return;
  }
  if (message.kind === "command.settled" && message.chatId === chatId) {
    pendingSubmits.delete(message.requestId);
    runState = message.runState;
    if (message.state === "failed") showError(`${message.code} · ${message.message}`);
    render();
    if (message.state === "settled")
      void readChatContext(chatId).then((draft) => applyBrowserContextDraft(draft));
    return;
  }
  if (message.kind === "command.failed") {
    pendingSubmits.delete(message.requestId);
    showError(`${message.code} · ${message.message}`);
    render();
  }
}
function handleChatEvent(message: Extract<DaemonUiResponse, { kind: "chat.event" }>): void {
  if (message.subscriptionId !== subscriptionId) return;
  cursor = message.event.cursor;
  if (message.event.event.kind === "view-replaced") {
    runState = message.event.event.runState;
    contextUsage = message.event.event.contextUsage;
  }
  if (message.event.event.kind === "chat-metadata") {
    document.title = `${message.event.event.title} · Aeon`;
    title = document.title;
    render();
    return;
  }
  if (message.event.event.kind === "context-usage") contextUsage = message.event.event.contextUsage;
  if (message.event.event.kind.startsWith("extension-ui-")) piUi.applyEvent(message.event.event);
  transcript.apply(message.event.event);
  if (message.event.event.kind === "run-state") runState = message.event.event.state;
  render();
}
function applySnapshot(
  snapshot: ChatViewSnapshotDto,
  nextCursor: { epoch: string; revision: number },
  nextSubscriptionId: string,
): void {
  if (snapshot.chat.chatId !== chatId) return;
  composer.setProjectName(snapshot.chat.projectId);
  subscriptionId = nextSubscriptionId;
  cursor = nextCursor;
  runState = snapshot.runState;
  contextUsage = snapshot.contextUsage;
  transcript.setSnapshot(snapshot.entries);
  document.title = `${snapshot.chat.title} · Aeon`;
  title = document.title;
  if (snapshot.omittedEntryCount > 0)
    showError(`${snapshot.omittedEntryCount} earlier Pi entries are outside this view.`);
  else notice = "";
  render();
}
function setConnection(label: string, state: "connecting" | "connected" | "error"): void {
  connection = { label, state };
  render();
}
function showError(message: string): void {
  notice = message;
  render();
}
function scheduleReconnect(): void {
  if (isClosing || reconnectTimer) return;
  reconnectAttempt += 1;
  const delay = Math.min(1000 * 2 ** Math.min(reconnectAttempt, 4), 15_000);
  reconnectTimer = globalThis.setTimeout(() => {
    reconnectTimer = 0;
    void connectAndSubscribe();
  }, delay);
}

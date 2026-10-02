import { type DaemonUiResponse } from "@pippin/protocol";
import {
  DevConnectRequestSchema,
  DevConnectResponseSchema,
  DevOpenChatRequestSchema,
  DevOpenChatResponseSchema,
} from "./dev-extension-message.js";
import { connectDevUi, type DevUiClient } from "./dev-ui-client.js";

let uiClient: DevUiClient | undefined;
let connectionGrant = "";
const status = requiredElement("connection-status", HTMLElement);
const executorStatus = requiredElement("executor-status", HTMLElement);
const grantInput = requiredElement("grant", HTMLInputElement);
const launcher = requiredElement("chat-launcher", HTMLElement);
const listElement = requiredElement("chat-list", HTMLUListElement);

requiredElement("connect-form", HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  void connect(grantInput.value.trim());
});
requiredElement("refresh-chats", HTMLButtonElement).addEventListener("click", () => {
  void refreshChats();
});
requiredElement("new-chat-form", HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  void createChat(requiredElement("chat-title", HTMLInputElement).value.trim());
});

async function connect(grant: string): Promise<void> {
  uiClient?.close();
  uiClient = undefined;
  connectionGrant = "";
  launcher.hidden = true;
  status.textContent = "Connecting to local fixture…";
  const result = await connectDevUi(grant);
  if (result.kind !== "connected") {
    status.textContent = `Chat connection failed · ${result.code}`;
    executorStatus.textContent = "Not attempted";
    return;
  }
  uiClient = result.client;
  connectionGrant = grant;
  launcher.hidden = false;
  status.textContent = "Connected · local faux model · no provider";
  const executorRequest = DevConnectRequestSchema.parse({
    kind: "pippin.dev.connect",
    connectionGrant: grant,
  });
  try {
    const response = DevConnectResponseSchema.safeParse(
      await chrome.runtime.sendMessage(executorRequest),
    );
    executorStatus.textContent = !response.success
      ? "Invalid worker response"
      : response.data.ok
        ? `Connected · protocol ${response.data.acknowledgement.protocolVersion.major}.${response.data.acknowledgement.protocolVersion.minor}`
        : response.data.code;
  } catch {
    executorStatus.textContent = "Extension worker unavailable";
  }
  await refreshChats();
}

async function refreshChats(): Promise<void> {
  const client = uiClient;
  if (!client) return;
  setChatStatus("Loading Chats…");
  try {
    const requestId = crypto.randomUUID();
    const after = client.send({
      kind: "command",
      requestId,
      operation: "chat.list",
      payload: { limit: 50 },
    });
    const response = await client.waitFor(isCommandResult(requestId), after);
    if (response.kind === "command.failed") throw new Error(response.message);
    if (response.kind !== "command.completed" || response.result.kind !== "chat.listed")
      throw new Error("Unexpected Chat list response.");
    renderChats(response.result.chats);
    setChatStatus(response.result.chats.length ? "" : "No Chats yet.");
  } catch (error) {
    setChatStatus(errorMessage(error));
  }
}

async function createChat(title: string): Promise<void> {
  const client = uiClient;
  if (!client || !connectionGrant) {
    setChatStatus("Connect to the local daemon first.");
    return;
  }
  try {
    const requestId = crypto.randomUUID();
    const after = client.send({
      kind: "command",
      requestId,
      operation: "chat.create",
      payload: title ? { title } : {},
    });
    const response = await client.waitFor(isCommandResult(requestId), after);
    if (response.kind === "command.failed") throw new Error(response.message);
    if (response.kind !== "command.completed" || response.result.kind !== "chat.created")
      throw new Error("Unexpected Chat creation response.");
    await openChat(response.result.chat.chatId);
    await refreshChats();
  } catch (error) {
    setChatStatus(errorMessage(error));
  }
}

function renderChats(
  chats: readonly { chatId: string; title: string; status: string; updatedAt: string }[],
): void {
  listElement.replaceChildren();
  for (const chat of chats) {
    const row = document.createElement("li");
    row.className = "chat-row";
    const copy = document.createElement("div");
    const title = document.createElement("p");
    title.className = "chat-title";
    title.textContent = chat.title;
    const meta = document.createElement("p");
    meta.className = "chat-meta";
    meta.textContent = `${chat.status} · ${formatDate(chat.updatedAt)}`;
    copy.append(title, meta);
    const button = document.createElement("button");
    button.className = "open-chat";
    button.type = "button";
    button.textContent = "Open";
    button.addEventListener("click", () => void openChat(chat.chatId));
    row.append(copy, button);
    listElement.append(row);
  }
}

async function openChat(chatId: string): Promise<void> {
  const request = DevOpenChatRequestSchema.parse({
    kind: "pippin.dev.open-chat",
    chatId,
    connectionGrant,
  });
  try {
    const response = DevOpenChatResponseSchema.safeParse(await chrome.runtime.sendMessage(request));
    if (!response.success) throw new Error("Invalid extension response.");
    if (!response.data.ok) throw new Error(response.data.code);
    setChatStatus("Chat opened in a new tab.");
  } catch (error) {
    setChatStatus(errorMessage(error));
  }
}

function isCommandResult(requestId: string) {
  return (
    message: DaemonUiResponse,
  ): message is Extract<DaemonUiResponse, { kind: "command.completed" | "command.failed" }> =>
    (message.kind === "command.completed" || message.kind === "command.failed") &&
    message.requestId === requestId;
}

function setChatStatus(message: string): void {
  requiredElement("chat-status", HTMLElement).textContent = message;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "recently updated"
    : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The local daemon could not complete this request.";
}

function requiredElement<T extends HTMLElement>(
  id: string,
  constructor: { new (...args: never[]): T },
): T {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) throw new Error(`Missing page element: ${id}`);
  return element;
}

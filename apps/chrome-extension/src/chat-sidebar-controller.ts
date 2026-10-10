import { type ChatSummaryDto, type DaemonUiResponse } from "@aeon/protocol";
import type { UiClient } from "./ui-client-core.js";

interface ChatSidebarOptions {
  currentChatId: string;
  client: () => UiClient | undefined;
  openChat(chatId: string): Promise<void>;
  onChange(): void;
  onError(message: string): void;
}

export class ChatSidebarController {
  chats: ChatSummaryDto[] = [];
  open = false;
  query = "";

  constructor(private readonly options: ChatSidebarOptions) {}

  setOpen(open: boolean): void {
    this.open = open;
    localStorage.setItem("aeon-sidebar-expanded", String(open));
    this.options.onChange();
    if (open) void this.refresh();
  }

  setQuery(query: string): void {
    this.query = query;
    this.options.onChange();
  }

  actionProps(): {
    onPinChat(chat: ChatSummaryDto): void;
    onDeleteChat(chat: ChatSummaryDto): void;
  } {
    return {
      onPinChat: (chat: ChatSummaryDto) => void this.changeChat(chat, "pin"),
      onDeleteChat: (chat: ChatSummaryDto) => void this.changeChat(chat, "delete"),
    };
  }

  async changeChat(chat: ChatSummaryDto, operation: "pin" | "delete"): Promise<void> {
    const client = this.options.client();
    if (!client) return;
    try {
      const requestId = crypto.randomUUID();
      const after = client.send(
        operation === "pin"
          ? {
              kind: "command",
              requestId,
              operation: "chat.update",
              payload: { chatId: chat.chatId, pinned: !chat.pinned },
            }
          : {
              kind: "command",
              requestId,
              operation: "chat.delete",
              payload: { chatId: chat.chatId },
            },
      );
      const response = await client.waitFor(
        (message) => isCommandResponse(message, requestId),
        after,
      );
      if (response.kind === "command.failed") throw new Error(response.message);
      if (operation === "delete" && chat.chatId === this.options.currentChatId) {
        location.href = "home.html";
        return;
      }
      await this.refresh();
    } catch (error) {
      this.options.onError(errorMessage(error));
    }
  }

  async createChat(): Promise<void> {
    const client = this.options.client();
    if (!client) return;
    try {
      const requestId = crypto.randomUUID();
      const after = client.send({
        kind: "command",
        requestId,
        operation: "chat.create",
        payload: {},
      });
      const response = await client.waitFor(
        (message) => isCommandResponse(message, requestId),
        after,
      );
      if (response.kind === "command.failed") throw new Error(response.message);
      if (response.kind !== "command.completed" || response.result.kind !== "chat.created")
        throw new Error("Unexpected Chat creation response.");
      await this.openChatTab(response.result.chat.chatId);
    } catch (error) {
      this.options.onError(errorMessage(error));
    }
  }

  async refresh(): Promise<void> {
    const client = this.options.client();
    if (!client) return;
    try {
      const requestId = crypto.randomUUID();
      const after = client.send({
        kind: "command",
        requestId,
        operation: "chat.list",
        payload: { limit: 50 },
      });
      const response = await client.waitFor(
        (message) => isCommandResponse(message, requestId),
        after,
      );
      if (response.kind === "command.failed") throw new Error(response.message);
      if (response.kind !== "command.completed" || response.result.kind !== "chat.listed") return;
      this.chats = [...response.result.chats];
      this.options.onChange();
    } catch (error) {
      this.options.onError(errorMessage(error));
    }
  }

  async openChat(chatId: string): Promise<void> {
    if (chatId === this.options.currentChatId) return;
    try {
      await this.openChatTab(chatId);
    } catch (error) {
      this.options.onError(errorMessage(error));
    }
  }

  private async openChatTab(chatId: string): Promise<void> {
    await this.options.openChat(chatId);
  }
}

function isCommandResponse(
  message: DaemonUiResponse,
  requestId: string,
): message is Extract<DaemonUiResponse, { kind: "command.completed" | "command.failed" }> {
  return (
    (message.kind === "command.completed" || message.kind === "command.failed") &&
    message.requestId === requestId
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The local daemon could not complete this request.";
}

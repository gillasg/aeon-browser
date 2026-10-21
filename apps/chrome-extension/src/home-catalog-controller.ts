import { type ChatCatalogItemDto, type DaemonUiResponse } from "@aeon/protocol";
import type { UiClient } from "./ui-client-core.js";

interface HomeCatalogOptions {
  client(): UiClient | undefined;
  onError(message: string): void;
  onClearError(): void;
  onChange(): void;
  refreshHome(): Promise<void>;
}

export class HomeCatalogController {
  open = false;
  query = "";
  includeArchived = false;
  results: ChatCatalogItemDto[] = [];
  searchWarnings = 0;
  pending = false;
  private searchTimer = 0;

  constructor(private readonly options: HomeCatalogOptions) {}

  show(): void {
    this.open = true;
    document.title = "All Chats · Aeon";
    this.options.onChange();
    void this.refresh();
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    document.title = "Aeon";
    this.options.onChange();
  }

  setQuery(query: string): void {
    this.query = query;
    this.options.onChange();
    globalThis.clearTimeout(this.searchTimer);
    this.searchTimer = globalThis.setTimeout(() => void this.refresh(), 180);
  }

  setIncludeArchived(includeArchived: boolean): void {
    this.includeArchived = includeArchived;
    this.options.onChange();
    void this.refresh();
  }

  async listChats(
    limit: number,
    query: string,
    includeArchived: boolean,
  ): Promise<ChatCatalogItemDto[] | undefined> {
    const client = this.options.client();
    if (!client) return undefined;
    try {
      const requestId = crypto.randomUUID();
      const payload = { limit, includeArchived, ...(query ? { query } : {}) };
      const after = client.send({ kind: "command", requestId, operation: "chat.list", payload });
      const response = await client.waitFor(
        (message) => isCommandResponse(message, requestId),
        after,
      );
      if (response.kind === "command.failed") throw new Error(response.message);
      if (response.kind !== "command.completed" || response.result.kind !== "chat.listed")
        throw new Error("Unexpected Chat catalog response.");
      this.searchWarnings = response.result.searchWarnings ?? 0;
      this.options.onClearError();
      return response.result.chats;
    } catch (error) {
      this.options.onError(messageOf(error));
      return undefined;
    }
  }

  async refresh(): Promise<void> {
    this.pending = true;
    this.options.onChange();
    const chats = await this.listChats(100, this.query.trim(), this.includeArchived);
    if (chats) this.results = chats;
    this.pending = false;
    this.options.onChange();
  }

  async togglePinned(chat: ChatCatalogItemDto): Promise<void> {
    await this.update(chat.chatId, { pinned: !chat.pinned });
  }

  async toggleArchived(chat: ChatCatalogItemDto): Promise<void> {
    await this.update(chat.chatId, { archived: !chat.archived });
  }

  async deleteChat(chat: ChatCatalogItemDto): Promise<void> {
    const client = this.options.client();
    if (!client) return;
    try {
      const requestId = crypto.randomUUID();
      const after = client.send({
        kind: "command",
        requestId,
        operation: "chat.delete",
        payload: { chatId: chat.chatId },
      });
      const response = await client.waitFor(
        (message) => isCommandResponse(message, requestId),
        after,
      );
      if (response.kind === "command.failed") throw new Error(response.message);
      await this.options.refreshHome();
      if (this.open) await this.refresh();
    } catch (error) {
      this.options.onError(messageOf(error));
    }
  }

  async rename(chat: ChatCatalogItemDto): Promise<void> {
    const title = window.prompt("Rename Chat", chat.title)?.trim();
    if (title && title !== chat.title) await this.update(chat.chatId, { title });
  }

  private async update(
    chatId: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean },
  ): Promise<void> {
    const client = this.options.client();
    if (!client) return;
    try {
      const requestId = crypto.randomUUID();
      const after = client.send({
        kind: "command",
        requestId,
        operation: "chat.update",
        payload: { chatId, ...patch },
      });
      const response = await client.waitFor(
        (message) => isCommandResponse(message, requestId),
        after,
      );
      if (response.kind === "command.failed") throw new Error(response.message);
      await this.options.refreshHome();
      if (this.open) await this.refresh();
    } catch (error) {
      this.options.onError(messageOf(error));
    }
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "The local operation failed.";
}

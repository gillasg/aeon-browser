import {
  PiBrowserContextRecordSchema,
  type DaemonUiRequest,
  type DaemonUiResponse,
  type PiBrowserContextRecord,
  type PiEntryDto,
  type PiModelCatalogDto,
  type PiSessionEventDto,
} from "@aeon/protocol";
import { subscribeSavedChat } from "../chat-subscribe-client.js";
import type { UiClient } from "../ui-client-core.js";
import { connectPage, connectionErrorMessage } from "../ui-connection.js";

// The orb's line to the daemon: a catalog connection to start a chat, then a chat connection
// for that chat's event stream (the same grants the side panel and chat page use).

export interface OrbSessionListener {
  event(event: PiSessionEventDto): void;
  snapshot(entries: readonly PiEntryDto[], runState: string): void;
  closed(): void;
}

type CommandRequest = Extract<DaemonUiRequest, { kind: "command" }>;
type CompletedResult = Extract<DaemonUiResponse, { kind: "command.completed" }>["result"];

export class OrbSession {
  private catalog: UiClient | undefined;
  private chat: UiClient | undefined;
  chatId: string | undefined;

  constructor(
    private readonly tabId: number,
    private readonly listener: OrbSessionListener,
  ) {}

  async connect(): Promise<void> {
    const result = await connectPage({ kind: "catalog" });
    if (result.kind !== "connected") throw new Error(connectionErrorMessage(result.code));
    this.catalog = result.client;
  }

  async model(): Promise<{ model: { provider: string; id: string }; thinkingLevel: string }> {
    const result = await command(this.requireCatalog(), {
      operation: "chat.model-catalog",
      payload: {},
    });
    if (result.kind !== "chat.model-catalog") throw new Error("Pi did not return its models.");
    return pickModel(result.catalog);
  }

  /** Starts a new chat for this prompt with the orb's tab as context, then follows it. */
  async start(text: string): Promise<void> {
    const { model, thinkingLevel } = await this.model();
    const page = await this.page();
    const result = await command(this.requireCatalog(), {
      operation: "chat.create",
      payload: {
        initialSubmit: { text, model, thinkingLevel, ...(page ? { browserContexts: [page] } : {}) },
      },
    });
    if (result.kind !== "chat.created") throw new Error("The chat was not created.");
    this.chatId = result.chat.chatId;
    await this.follow(result.chat.chatId);
  }

  /** Sends the same prompt again in the same chat. */
  async again(text: string): Promise<void> {
    if (!this.chat || !this.chatId) return this.start(text);
    const page = await this.page();
    await command(this.chat, {
      operation: "chat.submit",
      payload: { chatId: this.chatId, text, ...(page ? { browserContexts: [page] } : {}) },
    });
  }

  async stop(): Promise<void> {
    if (this.chat && this.chatId)
      await command(this.chat, { operation: "chat.stop", payload: { chatId: this.chatId } });
  }

  close(): void {
    this.catalog?.close();
    this.chat?.close();
  }

  private async follow(chatId: string): Promise<void> {
    const result = await connectPage({ kind: "chat", chatId });
    if (result.kind !== "connected") throw new Error(connectionErrorMessage(result.code));
    this.chat = result.client;
    this.chat.socket.addEventListener("close", () => this.listener.closed(), { once: true });
    const response = await subscribeSavedChat(this.chat, chatId, undefined);
    if (response.kind !== "chat.snapshot" && response.kind !== "chat.resumed")
      throw new Error("Could not follow the chat.");
    if (response.kind === "chat.snapshot")
      this.listener.snapshot(response.snapshot.entries, response.snapshot.runState);
    this.chat.subscribe((message) => {
      if (message.kind === "chat.event" && message.chatId === chatId)
        this.listener.event(message.event.event);
    });
  }

  private async page(): Promise<PiBrowserContextRecord | undefined> {
    const raw: unknown = await chrome.runtime
      .sendMessage({ kind: "aeon.native.capture-page", tabId: this.tabId })
      .catch(() => null);
    const parsed = PiBrowserContextRecordSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  private requireCatalog(): UiClient {
    if (!this.catalog) throw new Error("Aeon is not connected.");
    return this.catalog;
  }
}

async function command(
  client: UiClient,
  request: Omit<CommandRequest, "kind" | "requestId">,
): Promise<CompletedResult> {
  const requestId = crypto.randomUUID();
  const after = client.send({ kind: "command", requestId, ...request } as CommandRequest);
  const response = await client.waitFor(
    (message) =>
      (message.kind === "command.completed" || message.kind === "command.failed") &&
      message.requestId === requestId,
    after,
  );
  if (response.kind === "command.failed") throw new Error(response.message);
  if (response.kind !== "command.completed") throw new Error("Unexpected daemon response.");
  return response.result;
}

export function pickModel(catalog: PiModelCatalogDto): {
  model: { provider: string; id: string };
  thinkingLevel: string;
} {
  const chosen =
    catalog.models.find(
      (model) =>
        model.provider === catalog.defaultModel?.provider && model.id === catalog.defaultModel?.id,
    ) ?? catalog.models[0];
  if (!chosen) throw new Error("Sign in to a model in Aeon first.");
  return {
    model: { provider: chosen.provider, id: chosen.id },
    thinkingLevel: chosen.defaultThinkingLevel,
  };
}

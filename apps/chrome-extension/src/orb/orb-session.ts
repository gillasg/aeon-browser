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
import { homeSites, type SiteRows } from "../site-facts.js";
import type { SummonTarget } from "./orb-target.js";

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
  private modelChoice: ReturnType<OrbSession["model"]> | undefined;
  chatId: string | undefined;

  constructor(
    private readonly tabId: number,
    private readonly listener: OrbSessionListener,
  ) {}

  async connect(): Promise<void> {
    const result = await connectPage({ kind: "catalog" });
    if (result.kind !== "connected") throw new Error(connectionErrorMessage(result.code));
    this.catalog = result.client;
    // Chosen ahead, so sending does not wait for the model list.
    this.modelChoice = this.model();
    this.modelChoice.catch(() => (this.modelChoice = undefined));
  }

  /** Saved APIs and active watches per site, for the X-Ray strip. */
  sites(): Promise<SiteRows> {
    return homeSites(this.requireCatalog());
  }

  /** What the user pointed at rides with the message as structured context, never as text. */
  target: SummonTarget | undefined;

  /** Recent chats, for the orb's switcher. */
  async listChats(): Promise<{ chatId: string; title: string; updatedAt: string }[]> {
    const result = await command(this.requireCatalog(), {
      operation: "chat.list",
      payload: { limit: 50 },
    });
    return result.kind === "chat.listed"
      ? result.chats.map(({ chatId, title, updatedAt }) => ({ chatId, title, updatedAt }))
      : [];
  }

  async model(): Promise<{ model: { provider: string; id: string }; thinkingLevel: string }> {
    const result = await command(this.requireCatalog(), {
      operation: "chat.model-catalog",
      payload: {},
    });
    if (result.kind !== "chat.model-catalog") throw new Error("Pi did not return its models.");
    return pickModel(result.catalog);
  }

  /**
   * Starts a new chat for this prompt with the chosen tabs (the orb's own, unless removed) as context. `created` runs as soon as
   * the chat exists, so the box can show it while the event stream connects.
   */
  async start(
    text: string,
    tabIds: readonly number[] = [this.tabId],
    created?: (chatId: string) => void,
  ): Promise<void> {
    const [{ model, thinkingLevel }, ...captured] = await Promise.all([
      this.modelChoice ?? this.model(),
      ...tabIds.map((tabId) => this.page(tabId)),
    ]);
    const pages = captured
      .filter((page): page is PiBrowserContextRecord => Boolean(page))
      .map((page) => (page.target.tabId === this.tabId ? withTarget(page, this.target) : page));
    const result = await command(this.requireCatalog(), {
      operation: "chat.create",
      payload: {
        initialSubmit: {
          text,
          typedByUser: true,
          model,
          thinkingLevel,
          ...(pages.length ? { browserContexts: pages } : {}),
        },
      },
    });
    if (result.kind !== "chat.created") throw new Error("The chat was not created.");
    this.chatId = result.chat.chatId;
    created?.(result.chat.chatId);
    await this.follow(result.chat.chatId);
  }

  /** Follows another chat (the switcher), or none (a new chat to compose). */
  async switchTo(chatId: string | undefined): Promise<void> {
    this.chat?.close();
    this.chat = undefined;
    this.chatId = chatId;
    if (chatId) await this.follow(chatId);
  }

  /** Sends the same prompt again in the same chat. */
  async again(text: string): Promise<void> {
    if (!this.chat || !this.chatId) return this.start(text);
    const captured = await this.page();
    const page = captured ? withTarget(captured, this.target) : undefined;
    await command(this.chat, {
      operation: "chat.submit",
      payload: {
        chatId: this.chatId,
        text,
        typedByUser: true,
        ...(page ? { browserContexts: [page] } : {}),
      },
    });
  }

  async stop(): Promise<void> {
    if (this.chat && this.chatId)
      await command(this.chat, { operation: "chat.stop", payload: { chatId: this.chatId } });
  }

  /** Creates a routine in this chat through the routines system (the chat grant covers its own chat). */
  async createRoutine(routine: Record<string, unknown>): Promise<void> {
    if (!this.chat || !this.chatId) throw new Error("This run has no chat to watch from.");
    const result = await command(this.chat, {
      operation: "management.action",
      payload: { chatId: this.chatId, action: "create_routine", input: routine },
    });
    if (result.kind !== "management.snapshot") throw new Error("The routine was not saved.");
  }

  /** Marks the route or ability behind this run's answer as wrong, through the management grant. */
  async reportWrong(input: { site: string; quirk: string }): Promise<void> {
    if (!this.chat || !this.chatId) return;
    await command(this.chat, {
      operation: "management.action",
      payload: { chatId: this.chatId, action: "report_wrong", input },
    });
  }

  /** After the link dropped (the daemon restarted): connect again and follow the same chat, which
   * sends a fresh snapshot. */
  async reconnect(): Promise<void> {
    const chat = this.chat;
    this.chat = undefined;
    chat?.close();
    this.catalog?.close();
    await this.connect();
    if (this.chatId) await this.follow(this.chatId);
  }

  close(): void {
    this.catalog?.close();
    this.chat?.close();
  }

  private async follow(chatId: string): Promise<void> {
    const result = await connectPage({ kind: "chat", chatId });
    if (result.kind !== "connected") throw new Error(connectionErrorMessage(result.code));
    if (this.chatId !== chatId) return result.client.close();
    this.chat = result.client;
    const client = result.client;
    client.socket.addEventListener(
      "close",
      () => {
        if (this.chat === client) this.listener.closed();
      },
      { once: true },
    );
    const response = await subscribeSavedChat(client, chatId, undefined);
    if (response.kind !== "chat.snapshot" && response.kind !== "chat.resumed")
      throw new Error("Could not follow the chat.");
    if (response.kind === "chat.snapshot")
      this.listener.snapshot(response.snapshot.entries, response.snapshot.runState);
    client.subscribe((message) => {
      if (message.kind === "chat.event" && message.chatId === chatId && this.chatId === chatId)
        this.listener.event(message.event.event);
    });
  }

  private async page(tabId = this.tabId): Promise<PiBrowserContextRecord | undefined> {
    const raw: unknown = await chrome.runtime
      .sendMessage({ kind: "aeon.native.capture-page", tabId })
      .catch(() => null);
    const parsed = PiBrowserContextRecordSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  private requireCatalog(): UiClient {
    if (!this.catalog) throw new Error("Aeon is not connected.");
    return this.catalog;
  }
}

/** The selection becomes the record's selected text; an element rides as `element`. */
export function withTarget(
  page: PiBrowserContextRecord,
  target: SummonTarget | undefined,
): PiBrowserContextRecord {
  if (!target) return page;
  if (target.selection)
    return { ...page, kind: "selection", selectedText: target.title.slice(0, 8000) };
  return { ...page, element: target.payload };
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

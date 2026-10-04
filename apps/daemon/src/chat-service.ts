import { boundedChatEntries, type ObservedSession } from "./bounded-chat-entries.js";
import { ProjectService } from "./project-service.js";
import { deleteStoredChat } from "./chat-deletion.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  asActivationId,
  type ActivationId,
  type ChatEventCursor,
  type ChatId,
  type ChatCatalogItem,
  type ChatMetadataPatch,
  type ChatRecord,
  type ChatSummary,
  type ChatStore,
  type ThreadCoordinationStore,
  type ChatViewSnapshot,
  type PiSessionEvent,
  type PiSessionHandle,
  type PiSessionInput,
  type PiSessionControlState,
  type PiModelCatalog,
  type PiSessionPort,
  type ThreadCreationIntent,
  type CreateThreadForkInput,
  type ThreadForkIntent,
  type PiForkEntryCheck,
  PiSessionUnavailableError,
} from "@pippin/domain";
import { ChatCommandGate } from "./chat-command-gate.js";
import { ChatThreadSupport } from "./chat-thread-support.js";
import { ChatMetadataService } from "./chat-metadata-service.js";
import { searchChats as searchChatCatalog } from "./chat-catalog-search.js";
import { readEffectiveResources } from "./chat-effective-resources.js";
import { ChatManagementCommands } from "./chat-management.js";
import { activationIdFor, toChatSummary } from "./chat-projection.js";
import {
  ChatEventHub,
  type ChatEventSubscription,
  type PublishedChatEvent,
} from "./chat-event-hub.js";
export class ChatService {
  private readonly store: ChatStore & ThreadCoordinationStore;
  private readonly pi: PiSessionPort;
  private readonly threadSupport: ChatThreadSupport;
  private readonly metadata: ChatMetadataService;
  private readonly commandGate = new ChatCommandGate();
  private readonly eventHub = new ChatEventHub();
  private readonly observedSessions = new Map<ChatId, ObservedSession>();
  readonly projects: ProjectService;
  readonly management: ChatManagementCommands;
  constructor(options: {
    dataDirectory: string;
    store: ChatStore & ThreadCoordinationStore;
    pi: PiSessionPort;
  }) {
    const dataDirectory = resolve(options.dataDirectory);
    this.store = options.store;
    this.pi = options.pi;
    this.projects = new ProjectService(dataDirectory);
    this.threadSupport = new ChatThreadSupport(dataDirectory, this.store, this.pi);
    this.metadata = new ChatMetadataService(this.store, this.eventHub);
    this.management = new ChatManagementCommands(
      (chatId) => Boolean(this.store.getChat(chatId)),
      () => this.listChats(100),
    );
  }
  createDraft = (title = "New Chat", projectId?: string): Promise<ChatRecord> =>
    this.threadSupport.createDraft(title, projectId ? this.projects.get(projectId) : undefined);
  async createThreadDraft(input: {
    senderChatId: ChatId;
    targetChatId: ChatId;
    title: string;
    idempotencyKey: string;
    payloadHash: string;
  }): Promise<{ intent: ThreadCreationIntent; chat: ChatRecord }> {
    return this.threadSupport.createThreadDraft(input);
  }
  async createForkDraft(input: CreateThreadForkInput): Promise<ThreadForkIntent> {
    return this.threadSupport.createForkDraft(input);
  }
  withSession<T>(
    chatId: ChatId,
    operation: (session: PiSessionHandle, chat: ChatRecord) => Promise<T> | T,
  ): Promise<T> {
    return this.commandGate.run(chatId, async () => {
      const { activeChat, session } = await this.resolveSession(this.requireChat(chatId));
      this.observeSession(chatId, session);
      return operation(session, activeChat);
    });
  }
  async readToolImage(
    chatId: ChatId,
    toolCallId: string,
    index: number,
  ): Promise<{ mimeType: string; bytes: Uint8Array }> {
    const { session } = await this.resolveSession(this.requireChat(chatId));
    if (!session.readToolImage) throw new Error("Image retrieval is unavailable");
    return session.readToolImage(toolCallId, index);
  }
  forkFromEntry(
    input: Parameters<ChatThreadSupport["forkFromEntry"]>[0],
  ): ReturnType<ChatThreadSupport["forkFromEntry"]> {
    return this.threadSupport.forkFromEntry(input);
  }
  inspectForkEntry(input: Parameters<ChatThreadSupport["inspectForkEntry"]>[0]): PiForkEntryCheck {
    return this.threadSupport.inspectForkEntry(input);
  }
  findDetachedFork(
    input: Parameters<ChatThreadSupport["findDetachedFork"]>[0],
  ): ReturnType<ChatThreadSupport["findDetachedFork"]> {
    return this.threadSupport.findDetachedFork(input);
  }
  getChat = (chatId: ChatId): ChatRecord | undefined => this.store.getChat(chatId);
  listChats(limit = 50, includeArchived = false): readonly ChatSummary[] {
    return this.store.listChats(limit, includeArchived).map(toChatSummary);
  }
  getModelCatalog = (): Promise<PiModelCatalog> => this.pi.getModelCatalog();
  async searchChats(
    query: string,
    limit = 50,
    includeArchived = true,
  ): Promise<{ chats: readonly ChatCatalogItem[]; searchWarnings: number }> {
    return searchChatCatalog(this.store, this.pi, query, limit, includeArchived);
  }
  deleteChat = (chatId: ChatId): Promise<void> =>
    deleteStoredChat(this.store, this.observedSessions, this.commandGate, chatId);
  updateMetadata(chatId: ChatId, patch: ChatMetadataPatch): ChatSummary {
    return this.metadata.update(chatId, patch);
  }
  async getChatView(chatId: ChatId): Promise<{
    snapshot: ChatViewSnapshot;
    cursor: ChatEventCursor;
  }> {
    let chat = this.requireChat(chatId);
    let entries: ChatViewSnapshot["entries"] = [];
    let omittedEntryCount = 0;
    let runState: ChatViewSnapshot["runState"] = chat.status === "failed" ? "uncertain" : "idle";
    let contextUsage: ChatViewSnapshot["contextUsage"] = null;
    if (chat.status === "ready" || chat.status === "creating") {
      const resolved = await this.resolveSession(chat);
      chat = resolved.activeChat;
      this.observeSession(chatId, resolved.session);
      const piSnapshot = resolved.session.snapshot();
      ({ entries, omittedEntryCount } = boundedChatEntries(piSnapshot.entries));
      runState = piSnapshot.runState;
      contextUsage = piSnapshot.contextUsage;
    }
    return {
      snapshot: { chat: toChatSummary(chat), runState, contextUsage, entries, omittedEntryCount },
      cursor: this.eventHub.cursor(chatId),
    };
  }
  getEffectiveResources(chatId: ChatId): Promise<import("@pippin/domain").EffectivePiResources> {
    return readEffectiveResources(this, chatId);
  }
  async refreshViews(chatId: ChatId): Promise<Awaited<ReturnType<ChatService["getChatView"]>>> {
    const view = await this.getChatView(chatId);
    const { entries, runState, contextUsage } = view.snapshot;
    const published = this.eventHub.publish(chatId, {
      kind: "view-replaced",
      entries,
      runState,
      contextUsage,
    });
    return { ...view, cursor: published.cursor };
  }
  subscribeFrom(
    chatId: ChatId,
    cursor: ChatEventCursor | undefined,
    listener: (event: PublishedChatEvent) => void,
  ): ChatEventSubscription {
    return this.eventHub.subscribeFrom(chatId, cursor, listener);
  }
  submitPrompt(chatId: ChatId, input: PiSessionInput | string): Promise<ChatRecord> {
    const prompt = typeof input === "string" ? { text: input } : input;
    if (!prompt.text.trim()) return Promise.reject(new Error("Prompt text must not be empty."));
    return this.commandGate.run(chatId, async () => {
      let chat = this.requireChat(chatId);
      const { activeChat, session } = await this.resolveSession(chat);
      chat = this.metadata.nameInitialPrompt(activeChat, session, prompt.text);
      this.observeSession(chatId, session);
      try {
        await session.submit(prompt);
      } catch (error) {
        this.recordMaterializedSession(chatId, session);
        throw error;
      }
      return this.recordMaterializedSession(chatId, session) ?? chat;
    });
  }
  async getControls(chatId: ChatId): Promise<PiSessionControlState | null> {
    const chat = this.requireChat(chatId);
    if (chat.status === "failed") return null;
    const { session } = await this.resolveSession(chat);
    this.observeSession(chatId, session);
    return session.controls();
  }
  async setModel(chatId: ChatId, provider: string, id: string): Promise<void> {
    const { session } = await this.resolveSession(this.requireChat(chatId));
    this.observeSession(chatId, session);
    await session.setModel(provider, id);
  }
  async setThinkingLevel(chatId: ChatId, level: string): Promise<void> {
    const { session } = await this.resolveSession(this.requireChat(chatId));
    this.observeSession(chatId, session);
    session.setThinkingLevel(level);
  }
  async queueInput(
    chatId: ChatId,
    input: PiSessionInput,
    mode: "followUp" | "steer",
  ): Promise<void> {
    const { session } = await this.resolveSession(this.requireChat(chatId));
    this.observeSession(chatId, session);
    if (!session.controls().active)
      throw new Error("Queue input is only available while Pi is running.");
    await session.queue(input, mode);
  }
  async stop(chatId: ChatId): Promise<void> {
    const { session } = await this.resolveSession(this.requireChat(chatId));
    this.observeSession(chatId, session);
    await session.abort();
  }
  private async resolveSession(chat: ChatRecord): Promise<{
    activeChat: ChatRecord;
    session: PiSessionHandle;
  }> {
    let activeChat = this.beginOrResumeActivation(chat);
    if (activeChat.status === "unavailable") {
      throw new PiSessionUnavailableError("This Chat's Pi session needs manual recovery.");
    }
    const activationId = activationIdFor(activeChat);
    const session = await this.openSession(activeChat, activationId);
    activeChat = this.persistSessionReference(activeChat, activationId, session);
    return { activeChat, session };
  }
  private beginOrResumeActivation(chat: ChatRecord): ChatRecord {
    if (chat.status === "draft" || chat.status === "creating" || chat.status === "failed") {
      return this.store.beginActivation(chat.chatId, asActivationId(randomUUID()));
    }
    return chat;
  }
  private async openSession(
    chat: ChatRecord,
    activationId: ActivationId,
  ): Promise<PiSessionHandle> {
    try {
      return await this.pi.openOrCreate({
        chatId: chat.chatId,
        activationId,
        workingDirectory: chat.workingDirectory,
        reference: chat.piReference,
        materialized: chat.piMaterialized,
      });
    } catch (error) {
      this.recordOpenFailure(chat, activationId, error);
      throw error;
    }
  }
  private recordOpenFailure(chat: ChatRecord, activationId: ActivationId, error: unknown): void {
    if (error instanceof PiSessionUnavailableError && chat.piReference) {
      this.store.markPiUnavailable(chat.chatId, chat.piReference.sessionId);
    } else if (chat.status === "creating") {
      this.store.markActivationFailed(chat.chatId, activationId);
    }
  }
  private persistSessionReference(
    chat: ChatRecord,
    activationId: ActivationId,
    session: PiSessionHandle,
  ): ChatRecord {
    if (chat.status === "creating") {
      return this.store.attachPiSession(
        chat.chatId,
        activationId,
        session.reference,
        session.snapshot().materialized,
      );
    }
    if (chat.piReference?.sessionFile !== session.reference.sessionFile && !chat.piMaterialized) {
      return this.store.repairUnmaterializedPiReference(
        chat.chatId,
        activationId,
        session.reference,
      );
    }
    return chat;
  }
  private recordMaterializedSession(
    chatId: ChatId,
    session: PiSessionHandle,
  ): ChatRecord | undefined {
    const { materialized, reference } = session.snapshot();
    return materialized ? this.store.markPiMaterialized(chatId, reference.sessionId) : undefined;
  }
  private observeSession(chatId: ChatId, session: PiSessionHandle): void {
    const current = this.observedSessions.get(chatId);
    if (current?.session === session) return;
    current?.unsubscribe();
    const unsubscribe = session.subscribe((event: PiSessionEvent) => {
      this.eventHub.publish(chatId, event);
    });
    this.observedSessions.set(chatId, { session, unsubscribe });
  }
  private requireChat(chatId: ChatId): ChatRecord {
    const chat = this.store.getChat(chatId);
    if (!chat) throw new Error(`Chat ${chatId} does not exist.`);
    return chat;
  }
}

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  asChatId,
  asActivationId,
  type ChatId,
  type ChatRecord,
  type ChatStore,
  type ThreadCoordinationStore,
  type CreateThreadForkInput,
  type PiDetachedForkEvidence,
  type PiForkEntryCheck,
  type PiSessionPort,
  type PiSessionReference,
  type PiSessionHandle,
  type ThreadCreationIntent,
  type ThreadForkIntent,
} from "@pippin/domain";

export class ChatThreadSupport {
  private readonly dataDirectory: string;
  private prepared: Promise<{ draft: ChatRecord; session: PiSessionHandle }> | undefined;
  private refill: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    dataDirectory: string,
    private readonly store: ChatStore & ThreadCoordinationStore,
    private readonly pi: PiSessionPort,
  ) {
    this.dataDirectory = resolve(dataDirectory);
  }

  async createDraft(
    title = "New Chat",
    project?: { projectId: string; folders: string[] },
  ): Promise<ChatRecord> {
    if (!project && this.prepared) {
      const pending = this.prepared;
      this.prepared = undefined;
      const { draft, session } = await pending;
      this.scheduleRefill();
      const now = new Date().toISOString();
      this.store.createDraft({
        ...draft,
        title: this.makeDraft(draft.chatId, title, null).title,
        createdAt: now,
        updatedAt: now,
      });
      const activationId = asActivationId(session.reference.sessionId);
      this.store.beginActivation(draft.chatId, activationId);
      return this.store.attachPiSession(
        draft.chatId,
        activationId,
        session.reference,
        session.snapshot().materialized,
      );
    }
    const chatId = asChatId(randomUUID());
    const draft = this.makeDraft(chatId, title, project?.projectId ?? null);
    if (project) draft.workingDirectory = project.folders[0] ?? draft.workingDirectory;
    await mkdir(draft.workingDirectory, { recursive: true });
    return this.store.createDraft(draft);
  }

  prepareNextDraft(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.pi.prepareResources) return Promise.resolve();
    if (!this.prepared) {
      const draft = this.makeDraft(asChatId(randomUUID()), "New Chat", null);
      const pending = mkdir(draft.workingDirectory, { recursive: true }).then(async () => {
        await this.pi.prepareResources?.(draft.workingDirectory);
        const session = await this.pi.openOrCreate({
          chatId: draft.chatId,
          activationId: asActivationId(randomUUID()),
          workingDirectory: draft.workingDirectory,
          reference: null,
          materialized: false,
        });
        return { draft, session };
      });
      this.prepared = pending;
      void pending.catch(() => {
        if (this.prepared === pending) this.prepared = undefined;
      });
    }
    return this.prepared.then(() => undefined);
  }

  closePreparation(): void {
    this.closed = true;
    if (this.refill) clearTimeout(this.refill);
    this.refill = undefined;
  }
  private scheduleRefill(): void {
    if (this.closed || this.refill) return;
    this.refill = setTimeout(() => {
      this.refill = undefined;
      void this.prepareNextDraft().catch(() => undefined);
    }, 1000);
    this.refill.unref();
  }

  async createThreadDraft(input: {
    senderChatId: ChatId;
    targetChatId: ChatId;
    title: string;
    idempotencyKey: string;
    payloadHash: string;
  }): Promise<{ intent: ThreadCreationIntent; chat: ChatRecord }> {
    const existing = this.store.getThreadCreation(input.senderChatId, input.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== input.payloadHash)
        throw new Error("create_thread idempotency key was reused with different input.");
      return { intent: existing, chat: this.requireChat(existing.targetChatId) };
    }
    const sender = this.requireChat(input.senderChatId);
    const draft = this.makeDraft(input.targetChatId, input.title, sender.projectId);
    if (sender.projectId) draft.workingDirectory = sender.workingDirectory;
    await mkdir(draft.workingDirectory, { recursive: true });
    const intent: ThreadCreationIntent = {
      senderChatId: input.senderChatId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.payloadHash,
      targetChatId: input.targetChatId,
      createdAt: draft.createdAt,
    };
    const created = this.store.createThreadCreation(intent, draft);
    return { intent: created, chat: this.requireChat(created.targetChatId) };
  }

  async createForkDraft(input: CreateThreadForkInput): Promise<ThreadForkIntent> {
    const existing = this.store.getThreadFork(input.senderChatId, input.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== input.payloadHash)
        throw new Error("fork_thread idempotency key was reused with different input.");
      return existing;
    }
    const source = this.requireChat(input.sourceChatId);
    const draft = this.makeDraft(input.targetChatId, input.title, source.projectId);
    await mkdir(draft.workingDirectory, { recursive: true });
    return this.store.createThreadFork(input, draft);
  }

  forkFromEntry(input: {
    sourceChatId: ChatId;
    entryId: string;
    targetChatId: ChatId;
  }): Promise<PiSessionReference> {
    const source = this.requireChat(input.sourceChatId);
    if (!source.piReference) return Promise.reject(new Error("Source Chat has no Pi session."));
    return this.pi.forkFromEntry({
      reference: source.piReference,
      workingDirectory: source.workingDirectory,
      entryId: input.entryId,
      targetChatId: input.targetChatId,
    });
  }

  inspectForkEntry(input: { sourceChatId: ChatId; entryId: string }): PiForkEntryCheck {
    const source = this.requireChat(input.sourceChatId);
    if (source.status !== "ready" || !source.piReference)
      return { supported: false, reason: "chat_not_ready" };
    return this.pi.inspectForkEntry({
      reference: source.piReference,
      workingDirectory: source.workingDirectory,
      entryId: input.entryId,
    });
  }

  findDetachedFork(input: {
    sourceChatId: ChatId;
    entryId: string;
    targetChatId: ChatId;
  }): PiDetachedForkEvidence {
    const source = this.requireChat(input.sourceChatId);
    if (!source.piReference) return { kind: "none" };
    return this.pi.findDetachedFork({
      sourceReference: source.piReference,
      workingDirectory: source.workingDirectory,
      entryId: input.entryId,
      targetChatId: input.targetChatId,
    });
  }

  private makeDraft(chatId: ChatId, title: string, projectId: string | null): ChatRecord {
    const normalizedTitle = title.trim();
    if (!normalizedTitle || normalizedTitle.length > 120)
      throw new Error("Chat title must be 1–120 characters.");
    const now = new Date().toISOString();
    return {
      chatId,
      title: normalizedTitle,
      projectId,
      pinned: false,
      archived: false,
      workingDirectory: join(this.dataDirectory, "workspaces", chatId),
      status: "draft",
      activationId: null,
      piReference: null,
      piMaterialized: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  private requireChat(chatId: ChatId): ChatRecord {
    const chat = this.store.getChat(chatId);
    if (!chat) throw new Error(`Chat ${chatId} does not exist.`);
    return chat;
  }
}

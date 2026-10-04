import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  asChatId,
  type ChatId,
  type ChatRecord,
  type ChatStore,
  type ThreadCoordinationStore,
  type CreateThreadForkInput,
  type PiDetachedForkEvidence,
  type PiForkEntryCheck,
  type PiSessionPort,
  type PiSessionReference,
  type ThreadCreationIntent,
  type ThreadForkIntent,
} from "@pippin/domain";

export class ChatThreadSupport {
  private readonly dataDirectory: string;

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
    const chatId = asChatId(randomUUID());
    const draft = this.makeDraft(chatId, title, project?.projectId ?? null);
    if (project) draft.workingDirectory = project.folders[0] ?? draft.workingDirectory;
    await mkdir(draft.workingDirectory, { recursive: true });
    return this.store.createDraft(draft);
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

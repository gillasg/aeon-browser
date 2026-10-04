import { randomUUID } from "node:crypto";
import {
  asChatId,
  PiForkUnsupportedEntryError,
  type ChatId,
  type ThreadCoordinationStore,
  type CreateThreadForkInput,
  type ThreadForkIntent,
} from "@pippin/domain";
import type { ThreadToolHost } from "@pippin/pi-adapter";
import { ChatService } from "./chat-service.js";
import {
  hash,
  integer,
  messageOf,
  record,
  requiredString,
  runWithKeyedLock,
} from "./thread-coordination-utils.js";
import { ThreadWaitService } from "./thread-wait-service.js";
import { ThreadDeliveryService } from "./thread-delivery-service.js";

export class ThreadCoordinationService implements ThreadToolHost {
  private readonly operationLocks = new Map<string, Promise<void>>();
  private readonly waitService: ThreadWaitService;
  private readonly deliveryService: ThreadDeliveryService;

  constructor(
    private readonly chats: ChatService,
    private readonly store: ThreadCoordinationStore,
  ) {
    this.waitService = new ThreadWaitService(chats, store);
    this.deliveryService = new ThreadDeliveryService(chats, store, () => this.waitService.notify());
  }

  async execute(
    chatIdValue: string,
    toolCallId: string,
    toolName: string,
    input: unknown,
  ): Promise<string> {
    const senderChatId = asChatId(chatIdValue);
    const args = record(input);
    switch (toolName) {
      case "create_thread":
        return runWithKeyedLock(
          this.operationLocks,
          `${senderChatId}:${toolName}:${requiredString(args, "idempotencyKey", 160)}`,
          () => this.createThread(senderChatId, args),
        );
      case "list_threads":
        return JSON.stringify({ threads: this.chats.listChats(100) });
      case "send_message_to_thread":
        return runWithKeyedLock(
          this.operationLocks,
          `${senderChatId}:${toolName}:${requiredString(args, "idempotencyKey", 160)}`,
          () => this.deliveryService.sendMessage(senderChatId, toolCallId, args),
        );
      case "read_thread":
        return this.readThread(args);
      case "wait_threads":
        return this.waitService.wait(senderChatId, args);
      case "fork_thread":
        return runWithKeyedLock(
          this.operationLocks,
          `${senderChatId}:${toolName}:${requiredString(args, "idempotencyKey", 160)}`,
          () => this.forkThread(senderChatId, args),
        );
      case "set_thread_title":
        return this.setTitle(args);
      default:
        throw new Error(`Unknown thread tool '${toolName}'.`);
    }
  }

  async recover(): Promise<void> {
    await this.deliveryService.recover();
    for (const intent of this.store.listOpenThreadForks()) {
      const evidence = this.chats.findDetachedFork({
        sourceChatId: intent.sourceChatId,
        entryId: intent.sourceEntryId,
        targetChatId: intent.targetChatId,
      });
      if (evidence.kind === "ambiguous") {
        this.store.updateThreadFork(intent.senderChatId, intent.idempotencyKey, {
          state: "uncertain",
          piReference: null,
          updatedAt: new Date().toISOString(),
          lastError: `Found ${evidence.count} Pi session files in the target fork directory.`,
        });
      } else if (evidence.kind === "found") {
        this.store.attachThreadForkedChat(
          intent.senderChatId,
          intent.idempotencyKey,
          evidence.reference,
        );
      } else if (intent.state === "pending" && !intent.lastError) {
        await this.performFork(intent);
      }
    }
  }

  close(): void {
    this.deliveryService.close();
  }

  async forkMessage(input: {
    sourceChatId: ChatId;
    entryId: string;
    title?: string;
    idempotencyKey: string;
  }): Promise<{
    status: "ready" | "unsupported" | "failed" | "uncertain";
    targetChatId: ChatId | null;
    chat: ReturnType<ChatService["getChat"]> | null;
    reason:
      | "chat_not_ready"
      | "entry_not_found"
      | "branch_without_assistant"
      | "fork_failed"
      | "outcome_uncertain"
      | null;
  }> {
    return runWithKeyedLock(
      this.operationLocks,
      `${input.sourceChatId}:fork_thread:${input.idempotencyKey}`,
      async () => {
        const source = this.chats.getChat(input.sourceChatId);
        if (!source) throw new Error(`Chat ${input.sourceChatId} does not exist.`);
        if (source.archived)
          throw new Error("Archived Chats must be reopened before forking them.");
        const title = input.title?.trim() || `${source.title} (fork)`.slice(0, 120);
        const existing = this.store.getThreadFork(input.sourceChatId, input.idempotencyKey);
        const payloadHash = hash({
          sourceChatId: input.sourceChatId,
          sourceEntryId: input.entryId,
          title,
        });
        if (existing && existing.payloadHash !== payloadHash)
          throw new Error("fork_thread idempotency key was reused with different input.");
        if (!existing) {
          const check = this.chats.inspectForkEntry({
            sourceChatId: input.sourceChatId,
            entryId: input.entryId,
          });
          if (!check.supported)
            return {
              status: "unsupported",
              targetChatId: null,
              chat: null,
              reason: check.reason,
            };
        }
        const serialized = await this.forkThread(input.sourceChatId, {
          threadId: input.sourceChatId,
          entryId: input.entryId,
          title,
          idempotencyKey: input.idempotencyKey,
        });
        return this.projectUiFork(serialized);
      },
    );
  }

  private async createThread(senderChatId: ChatId, args: Record<string, unknown>): Promise<string> {
    const title = requiredString(args, "title", 120);
    const idempotencyKey = requiredString(args, "idempotencyKey", 160);
    const payloadHash = hash({ title });
    const result = await this.chats.createThreadDraft({
      senderChatId,
      targetChatId: asChatId(randomUUID()),
      title,
      idempotencyKey,
      payloadHash,
    });
    return JSON.stringify({ thread: result.chat, createdAt: result.intent.createdAt });
  }

  private async readThread(args: Record<string, unknown>): Promise<string> {
    const threadId = asChatId(requiredString(args, "threadId", 36));
    const chat = this.chats.getChat(threadId);
    if (!chat) throw new Error(`Thread ${threadId} does not exist.`);
    if (chat.archived) throw new Error("Archived threads must be reopened before reading them.");
    const limit = args.limit === undefined ? 50 : integer(args.limit, 1, 100, "limit");
    const view = await this.chats.getChatView(threadId);
    return JSON.stringify({
      chat: view.snapshot.chat,
      runState: view.snapshot.runState,
      entries: view.snapshot.entries.slice(-limit),
      omittedEntryCount: view.snapshot.omittedEntryCount,
      cursor: view.cursor,
    });
  }

  private async forkThread(senderChatId: ChatId, args: Record<string, unknown>): Promise<string> {
    const sourceEntryId = requiredString(args, "entryId", 160);
    const sourceChatId = asChatId(requiredString(args, "threadId", 36));
    const source = this.chats.getChat(sourceChatId);
    if (!source) throw new Error(`Thread ${sourceChatId} does not exist.`);
    if (source.archived) throw new Error("Archived threads must be reopened before forking them.");
    const title = requiredString(args, "title", 120);
    const idempotencyKey = requiredString(args, "idempotencyKey", 160);
    const targetChatId = asChatId(randomUUID());
    const input: CreateThreadForkInput = {
      senderChatId,
      idempotencyKey,
      payloadHash: hash({ sourceChatId, sourceEntryId, title }),
      sourceChatId,
      sourceEntryId,
      targetChatId,
      title,
      createdAt: new Date().toISOString(),
    };
    const intent = await this.chats.createForkDraft(input);
    if (intent.state === "ready" || intent.state === "failed")
      return JSON.stringify({ fork: intent });
    const evidence = this.chats.findDetachedFork({
      sourceChatId: intent.sourceChatId,
      entryId: intent.sourceEntryId,
      targetChatId: intent.targetChatId,
    });
    if (evidence.kind === "found") {
      return JSON.stringify({
        fork: this.store.attachThreadForkedChat(
          intent.senderChatId,
          intent.idempotencyKey,
          evidence.reference,
        ),
      });
    }
    if (evidence.kind === "ambiguous" || intent.state === "uncertain" || intent.lastError)
      return JSON.stringify({
        fork: this.store.updateThreadFork(intent.senderChatId, intent.idempotencyKey, {
          state: "uncertain",
          piReference: null,
          updatedAt: new Date().toISOString(),
          lastError:
            evidence.kind === "ambiguous"
              ? `Found ${evidence.count} Pi session files in the target fork directory.`
              : (intent.lastError ?? "Fork outcome is uncertain; automatic retry was suppressed."),
        }),
      });
    return JSON.stringify({ fork: await this.performFork(intent) });
  }

  private projectUiFork(serialized: string): {
    status: "ready" | "failed" | "uncertain";
    targetChatId: ChatId;
    chat: ReturnType<ChatService["getChat"]> | null;
    reason: "fork_failed" | "outcome_uncertain" | null;
  } {
    const { fork } = JSON.parse(serialized) as { fork: ThreadForkIntent };
    if (fork.state === "ready") {
      const chat = this.chats.getChat(fork.targetChatId);
      if (!chat) throw new Error("The Pi fork is ready but its Chat record is missing.");
      return { status: "ready", targetChatId: fork.targetChatId, chat, reason: null };
    }
    if (fork.state === "uncertain")
      return {
        status: "uncertain",
        targetChatId: fork.targetChatId,
        chat: null,
        reason: "outcome_uncertain",
      };
    if (fork.state === "failed")
      return {
        status: "failed",
        targetChatId: fork.targetChatId,
        chat: null,
        reason: "fork_failed",
      };
    throw new Error("Pi fork is still pending after the daemon completed the command.");
  }

  private async performFork(intent: ThreadForkIntent): Promise<ThreadForkIntent> {
    try {
      const reference = await this.chats.forkFromEntry({
        sourceChatId: intent.sourceChatId,
        entryId: intent.sourceEntryId,
        targetChatId: intent.targetChatId,
      });
      return this.store.attachThreadForkedChat(
        intent.senderChatId,
        intent.idempotencyKey,
        reference,
      );
    } catch (error) {
      return this.store.updateThreadFork(intent.senderChatId, intent.idempotencyKey, {
        state: error instanceof PiForkUnsupportedEntryError ? "failed" : "uncertain",
        piReference: null,
        updatedAt: new Date().toISOString(),
        lastError: messageOf(error),
      });
    }
  }

  private setTitle(args: Record<string, unknown>): string {
    const threadId = asChatId(requiredString(args, "threadId", 36));
    const title = requiredString(args, "title", 120);
    return JSON.stringify({ thread: this.chats.updateMetadata(threadId, { title }) });
  }
}

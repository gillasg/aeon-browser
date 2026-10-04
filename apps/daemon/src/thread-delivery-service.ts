import { randomUUID } from "node:crypto";
import {
  asChatId,
  type ChatId,
  type ThreadCoordinationStore,
  type PiThreadDeliveryEvent,
  type PiThreadMessageAcceptance,
  type ThreadDeliveryRecord,
  type ThreadDeliveryState,
} from "@pippin/domain";
import { ChatService } from "./chat-service.js";
import { hash, messageOf, requiredString, stateRank } from "./thread-coordination-utils.js";

const MAX_MESSAGE_LENGTH = 20_000;

export class ThreadDeliveryService {
  private readonly subscriptions = new Map<ChatId, () => void>();

  constructor(
    private readonly chats: ChatService,
    private readonly store: ThreadCoordinationStore,
    private readonly notifyWaiters: () => void,
  ) {}

  async recover(): Promise<void> {
    for (const delivery of this.store.listOpenThreadDeliveries()) {
      if (delivery.state === "pending") continue;
      if (delivery.state === "submitting") {
        this.update(delivery.deliveryId, {
          state: "uncertain",
          lastError:
            "Daemon restarted after submission began; exact Pi acceptance was not persisted.",
        });
        continue;
      }
      await this.reconcileOnRecovery(delivery);
    }
  }

  close(): void {
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
  }

  async sendMessage(
    sender: ChatId,
    toolCallId: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const input = readDeliveryInput(args);
    if (sender === input.recipientChatId)
      throw new Error("A thread cannot send a message to itself.");
    const recipient = this.chats.getChat(input.recipientChatId);
    if (!recipient) throw new Error(`Thread ${input.recipientChatId} does not exist.`);
    if (recipient.archived)
      throw new Error("Archived threads must be reopened before receiving messages.");
    const delivery = this.getOrCreateDelivery(sender, toolCallId, input);
    if (delivery.state === "submitting") return this.reconcileSubmission(delivery);
    if (delivery.state !== "pending") return JSON.stringify({ delivery });
    return this.dispatch(delivery, sender, input);
  }

  private getOrCreateDelivery(
    senderChatId: ChatId,
    toolCallId: string,
    input: DeliveryInput,
  ): ThreadDeliveryRecord {
    const payloadHash = hash({
      recipientChatId: input.recipientChatId,
      message: input.message,
      mode: input.mode,
      inReplyTo: input.inReplyTo,
    });
    const existing = this.store.getThreadDeliveryByIdempotency(senderChatId, input.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== payloadHash)
        throw new Error("send_message_to_thread idempotency key was reused with different input.");
      if (existing.recipientChatId !== input.recipientChatId)
        throw new Error("This idempotency key already targets another thread.");
      return existing;
    }
    return this.store.createThreadDelivery({
      deliveryId: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      senderChatId,
      recipientChatId: input.recipientChatId,
      senderToolCallId: toolCallId,
      payloadHash,
      mode: input.mode,
      inReplyTo: input.inReplyTo,
      createdAt: new Date().toISOString(),
    }).record;
  }

  private async dispatch(
    original: ThreadDeliveryRecord,
    senderChatId: ChatId,
    input: DeliveryInput,
  ): Promise<string> {
    await this.observeRecipient(input.recipientChatId);
    this.update(original.deliveryId, {
      state: "submitting",
      attempt: original.attempt + 1,
      lastError: null,
    });
    try {
      const acceptance = await this.chats.withSession(input.recipientChatId, (session) =>
        session.deliverThreadMessage({
          deliveryId: original.deliveryId,
          senderChatId,
          recipientChatId: input.recipientChatId,
          senderTitle: this.chats.getChat(senderChatId)?.title ?? "Chat",
          senderToolCallId: original.senderToolCallId,
          message: input.message,
          inReplyTo: input.inReplyTo,
          mode: input.mode,
        }),
      );
      return JSON.stringify({ delivery: this.commitAcceptance(original, acceptance) });
    } catch (error) {
      return JSON.stringify({
        delivery: await this.reconcileAfterError(original, input.recipientChatId, error),
      });
    }
  }

  private commitAcceptance(
    original: ThreadDeliveryRecord,
    acceptance: PiThreadMessageAcceptance,
  ): ThreadDeliveryRecord {
    const latest = this.store.getThreadDelivery(original.deliveryId);
    if (latest && stateRank(latest.state) > stateRank(acceptance.state)) return latest;
    return this.update(original.deliveryId, {
      state: acceptance.state,
      piEntryId: acceptance.piEntryId ?? null,
      acceptedAt: new Date().toISOString(),
      lastError: null,
    });
  }

  private async reconcileAfterError(
    original: ThreadDeliveryRecord,
    recipientChatId: ChatId,
    error: unknown,
  ): Promise<ThreadDeliveryRecord> {
    const evidence = await this.chats
      .withSession(recipientChatId, (session) => session.findThreadDelivery(original.deliveryId))
      .catch(() => ({ state: "not-found" as const }));
    return evidence.state === "not-found"
      ? this.update(original.deliveryId, { state: "uncertain", lastError: messageOf(error) })
      : this.update(original.deliveryId, {
          state: evidence.state,
          piEntryId: evidence.piEntryId ?? null,
          acceptedTurnId: evidence.acceptedTurnId ?? null,
          acceptedAt: new Date().toISOString(),
          lastError: null,
        });
  }

  private async reconcileSubmission(original: ThreadDeliveryRecord): Promise<string> {
    const evidence = await this.chats.withSession(original.recipientChatId, (session) =>
      session.findThreadDelivery(original.deliveryId),
    );
    const delivery =
      evidence.state === "not-found"
        ? this.update(original.deliveryId, {
            state: "uncertain",
            lastError:
              "Pi does not prove whether this delivery was accepted; retry was suppressed.",
          })
        : this.update(original.deliveryId, {
            state: evidence.state,
            piEntryId: evidence.piEntryId ?? null,
            acceptedTurnId: evidence.acceptedTurnId ?? null,
            acceptedAt: original.acceptedAt ?? new Date().toISOString(),
            ...(evidence.state === "completed" || evidence.state === "failed"
              ? { completedAt: new Date().toISOString() }
              : {}),
            lastError: null,
          });
    return JSON.stringify({ delivery });
  }

  private async reconcileOnRecovery(original: ThreadDeliveryRecord): Promise<void> {
    try {
      const evidence = await this.chats.withSession(original.recipientChatId, (session) =>
        session.findThreadDelivery(original.deliveryId),
      );
      if (evidence.state === "completed" || evidence.state === "failed") {
        this.update(original.deliveryId, {
          state: evidence.state,
          piEntryId: evidence.piEntryId ?? original.piEntryId,
          acceptedTurnId: evidence.acceptedTurnId ?? original.acceptedTurnId,
          completedAt: new Date().toISOString(),
          lastError: null,
        });
      } else {
        this.update(original.deliveryId, {
          state: "uncertain",
          lastError: "Pi contains no durable exact-turn settlement receipt for this delivery.",
        });
      }
    } catch {
      this.update(original.deliveryId, {
        state: "uncertain",
        lastError: "Recipient Pi session could not be reconciled after restart.",
      });
    }
  }

  private async observeRecipient(chatId: ChatId): Promise<void> {
    if (this.subscriptions.has(chatId)) return;
    const unsubscribe = await this.chats.withSession(chatId, (session) =>
      session.subscribeThreadDelivery((event) => this.onDeliveryEvent(event)),
    );
    this.subscriptions.set(chatId, unsubscribe);
  }

  private onDeliveryEvent(event: PiThreadDeliveryEvent): void {
    const delivery = this.store.getThreadDelivery(event.deliveryId);
    if (!delivery || delivery.recipientChatId !== event.recipientChatId) return;
    const patch = eventPatch(event, delivery);
    this.update(event.deliveryId, patch);
  }

  private update(
    deliveryId: string,
    patch: Parameters<ThreadCoordinationStore["updateThreadDelivery"]>[1],
  ): ThreadDeliveryRecord {
    const updated = this.store.updateThreadDelivery(deliveryId, patch, new Date().toISOString());
    this.notifyWaiters();
    return updated;
  }
}

interface DeliveryInput {
  recipientChatId: ChatId;
  message: string;
  idempotencyKey: string;
  mode: "followUp" | "steer";
  inReplyTo: ChatId | null;
}

function readDeliveryInput(args: Record<string, unknown>): DeliveryInput {
  return {
    recipientChatId: asChatId(requiredString(args, "threadId", 36)),
    message: requiredString(args, "message", MAX_MESSAGE_LENGTH),
    idempotencyKey: requiredString(args, "idempotencyKey", 160),
    mode: args.mode === "steer" ? "steer" : "followUp",
    inReplyTo:
      args.inReplyTo === undefined ? null : asChatId(requiredString(args, "inReplyTo", 36)),
  };
}

function eventPatch(
  event: PiThreadDeliveryEvent,
  current: ThreadDeliveryRecord,
): Parameters<ThreadCoordinationStore["updateThreadDelivery"]>[1] {
  const state: ThreadDeliveryState = event.phase;
  return {
    state,
    piEntryId: event.piEntryId ?? current.piEntryId,
    acceptedTurnId: event.acceptedTurnId ?? current.acceptedTurnId,
    ...(event.phase === "accepted" || event.phase === "queued"
      ? { acceptedAt: new Date().toISOString() }
      : {}),
    ...(event.phase === "completed" || event.phase === "failed"
      ? { completedAt: new Date().toISOString() }
      : {}),
    lastError: event.message ?? null,
  };
}

import type { ChatId, ChatRecord, PiSessionReference } from "./chat.js";

export type ThreadDeliveryState =
  | "pending"
  | "submitting"
  | "accepted"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "uncertain";

export interface ThreadCreationIntent {
  senderChatId: ChatId;
  idempotencyKey: string;
  payloadHash: string;
  targetChatId: ChatId;
  createdAt: string;
}

export interface ThreadDeliveryRecord {
  deliveryId: string;
  idempotencyKey: string;
  senderChatId: ChatId;
  recipientChatId: ChatId;
  senderToolCallId: string;
  payloadHash: string;
  mode: "followUp" | "steer";
  inReplyTo: string | null;
  state: ThreadDeliveryState;
  piEntryId: string | null;
  piQueueItemId: string | null;
  acceptedTurnId: string | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
}

export interface CreateThreadDeliveryInput {
  deliveryId: string;
  idempotencyKey: string;
  senderChatId: ChatId;
  recipientChatId: ChatId;
  senderToolCallId: string;
  payloadHash: string;
  mode: "followUp" | "steer";
  inReplyTo: string | null;
  createdAt: string;
}

export interface ThreadDeliveryPatch {
  state?: ThreadDeliveryState;
  piEntryId?: string | null;
  piQueueItemId?: string | null;
  acceptedTurnId?: string | null;
  attempt?: number;
  acceptedAt?: string | null;
  completedAt?: string | null;
  lastError?: string | null;
}

export interface ThreadForkIntent {
  senderChatId: ChatId;
  idempotencyKey: string;
  payloadHash: string;
  sourceChatId: ChatId;
  sourceEntryId: string;
  targetChatId: ChatId;
  title: string;
  state: "pending" | "ready" | "failed" | "uncertain";
  piReference: PiSessionReference | null;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
}

export class PiForkUnsupportedEntryError extends Error {
  constructor() {
    super(
      "Pi 0.99.1 cannot persist an exact fork at this entry because its branch has no assistant message. Choose an entry whose branch contains an assistant response.",
    );
    this.name = "PiForkUnsupportedEntryError";
  }
}

export type CreateThreadForkInput = Omit<
  ThreadForkIntent,
  "state" | "piReference" | "updatedAt" | "lastError"
>;

export type PiDetachedForkEvidence =
  | { kind: "none" }
  | { kind: "found"; reference: PiSessionReference }
  | { kind: "ambiguous"; count: number };

export type PiThreadDeliveryEvent = {
  deliveryId: string;
  recipientChatId: ChatId;
  phase: "accepted" | "queued" | "running" | "completed" | "failed";
  piEntryId?: string;
  acceptedTurnId?: string;
  message?: string;
};

export interface PiThreadMessageInput {
  deliveryId: string;
  senderChatId: ChatId;
  recipientChatId: ChatId;
  senderTitle: string;
  senderToolCallId: string;
  message: string;
  inReplyTo: string | null;
  mode: "followUp" | "steer";
}

export interface PiThreadDeliveryEvidence {
  state: "not-found" | "queued" | "accepted" | "running" | "completed" | "failed";
  piEntryId?: string;
  acceptedTurnId?: string;
}

export interface PiThreadMessageAcceptance {
  state: "accepted" | "queued";
  piEntryId?: string;
  acceptedTurnId?: string;
}

export interface ThreadCoordinationStore {
  createThreadCreation(intent: ThreadCreationIntent, draft: ChatRecord): ThreadCreationIntent;
  getThreadCreation(senderChatId: ChatId, idempotencyKey: string): ThreadCreationIntent | undefined;
  createThreadDelivery(input: CreateThreadDeliveryInput): {
    record: ThreadDeliveryRecord;
    created: boolean;
  };
  getThreadDelivery(deliveryId: string): ThreadDeliveryRecord | undefined;
  getThreadDeliveryByIdempotency(
    senderChatId: ChatId,
    idempotencyKey: string,
  ): ThreadDeliveryRecord | undefined;
  listOpenThreadDeliveries(): readonly ThreadDeliveryRecord[];
  updateThreadDelivery(
    deliveryId: string,
    patch: ThreadDeliveryPatch,
    updatedAt: string,
  ): ThreadDeliveryRecord;
  createThreadFork(input: CreateThreadForkInput, draft: ChatRecord): ThreadForkIntent;
  getThreadFork(senderChatId: ChatId, idempotencyKey: string): ThreadForkIntent | undefined;
  listOpenThreadForks(): readonly ThreadForkIntent[];
  updateThreadFork(
    senderChatId: ChatId,
    idempotencyKey: string,
    patch: Pick<ThreadForkIntent, "state" | "piReference" | "updatedAt" | "lastError">,
  ): ThreadForkIntent;
  attachThreadForkedChat(
    senderChatId: ChatId,
    idempotencyKey: string,
    reference: PiSessionReference,
  ): ThreadForkIntent;
}

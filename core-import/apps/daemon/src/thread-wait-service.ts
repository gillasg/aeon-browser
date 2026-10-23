import {
  asChatId,
  type ChatId,
  type ThreadCoordinationStore,
  type ThreadDeliveryState,
} from "@aeon/domain";
import { ChatService } from "./chat-service.js";
import { integer, record, requiredString } from "./thread-coordination-utils.js";

type WaitTarget = { threadId: ChatId; deliveryId: string };
const DEFAULT_WAIT_MS = 30_000;

export class ThreadWaitService {
  private readonly waitEdges = new Map<ChatId, Set<ChatId>>();
  private readonly changeListeners = new Set<() => void>();

  constructor(
    private readonly chats: ChatService,
    private readonly store: ThreadCoordinationStore,
  ) {}

  notify(): void {
    for (const listener of this.changeListeners) listener();
  }

  async wait(senderChatId: ChatId, args: Record<string, unknown>): Promise<string> {
    if (!Array.isArray(args.deliveries) || args.deliveries.length < 1 || args.deliveries.length > 8)
      throw new Error("wait_threads requires one to eight exact delivery targets.");
    const targets = args.deliveries.map((item) => {
      const target = record(item);
      return {
        threadId: asChatId(requiredString(target, "threadId", 36)),
        deliveryId: requiredString(target, "deliveryId", 36),
      };
    });
    const timeout =
      args.timeoutMs === undefined
        ? DEFAULT_WAIT_MS
        : integer(args.timeoutMs, 0, 120_000, "timeoutMs");
    const recipients = [...new Set(targets.map(({ threadId }) => threadId))];
    this.addWaitEdges(senderChatId, recipients);
    const deadline = Date.now() + timeout;
    try {
      while (true) {
        const deliveries = targets.map((target) => this.requireOwnedDelivery(senderChatId, target));
        const terminal = deliveries.every((delivery) => isTerminal(delivery.state));
        if (terminal || Date.now() >= deadline) {
          const state = deliveries.some((delivery) => delivery.state === "uncertain")
            ? "needs_attention"
            : deliveries.some((delivery) => delivery.state === "failed")
              ? "failed"
              : terminal
                ? "completed"
                : "timeout";
          const cursors = await Promise.all(
            recipients.map(async (threadId) => ({
              threadId,
              cursor: (await this.chats.getChatView(threadId)).cursor,
            })),
          );
          return JSON.stringify({ state, deliveries, cursors });
        }
        await this.waitForChange(Math.min(750, Math.max(1, deadline - Date.now())));
      }
    } finally {
      this.removeWaitEdges(senderChatId, recipients);
    }
  }

  private requireOwnedDelivery(sender: ChatId, target: WaitTarget) {
    const delivery = this.store.getThreadDelivery(target.deliveryId);
    if (
      !delivery ||
      delivery.senderChatId !== sender ||
      delivery.recipientChatId !== target.threadId
    )
      throw new Error(
        "wait_threads target must identify a delivery sent by this Chat to that exact thread.",
      );
    return delivery;
  }

  private addWaitEdges(sender: ChatId, recipients: readonly ChatId[]): void {
    for (const recipient of recipients) {
      if (recipient === sender || this.reaches(recipient, sender))
        throw new Error("wait_threads would create a coordination cycle.");
    }
    const edges = this.waitEdges.get(sender) ?? new Set<ChatId>();
    for (const recipient of recipients) edges.add(recipient);
    this.waitEdges.set(sender, edges);
  }

  private removeWaitEdges(sender: ChatId, recipients: readonly ChatId[]): void {
    const edges = this.waitEdges.get(sender);
    if (!edges) return;
    for (const recipient of recipients) edges.delete(recipient);
    if (!edges.size) this.waitEdges.delete(sender);
  }

  private reaches(start: ChatId, target: ChatId, seen = new Set<ChatId>()): boolean {
    if (start === target) return true;
    if (seen.has(start)) return false;
    seen.add(start);
    for (const next of this.waitEdges.get(start) ?? [])
      if (this.reaches(next, target, seen)) return true;
    return false;
  }

  private waitForChange(timeout: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(), timeout);
      const finish = () => {
        clearTimeout(timer);
        this.changeListeners.delete(finish);
        resolve();
      };
      this.changeListeners.add(finish);
    });
  }
}

function isTerminal(state: ThreadDeliveryState): boolean {
  return state === "completed" || state === "failed" || state === "uncertain";
}

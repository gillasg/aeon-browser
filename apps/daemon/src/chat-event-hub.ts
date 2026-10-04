import { randomUUID } from "node:crypto";
import { type ChatEventCursor, type ChatId, type PiSessionEvent } from "@pippin/domain";

const MAX_EVENTS_PER_CHAT = 256;

export interface PublishedChatEvent {
  cursor: ChatEventCursor;
  event: PiSessionEvent;
}

interface ChatEventState {
  revision: number;
  events: PublishedChatEvent[];
  listeners: Set<(published: PublishedChatEvent) => void>;
}

export type ChatEventSubscription =
  | { kind: "snapshot-required"; cursor: ChatEventCursor }
  | {
      kind: "replay";
      subscriptionId: string;
      cursor: ChatEventCursor;
      events: readonly PublishedChatEvent[];
      unsubscribe(): void;
    };

export class ChatEventHub {
  readonly epoch = randomUUID();
  private readonly allListeners = new Set<(chatId: ChatId, event: PiSessionEvent) => void>();
  subscribeAll(listener: (chatId: ChatId, event: PiSessionEvent) => void): () => void {
    this.allListeners.add(listener);
    return () => this.allListeners.delete(listener);
  }
  private readonly chats = new Map<ChatId, ChatEventState>();

  cursor(chatId: ChatId): ChatEventCursor {
    return { epoch: this.epoch, revision: this.stateFor(chatId).revision };
  }

  publish(chatId: ChatId, event: PiSessionEvent): PublishedChatEvent {
    const state = this.stateFor(chatId);
    const published = {
      cursor: { epoch: this.epoch, revision: ++state.revision },
      event,
    };
    if (event.kind === "view-replaced") state.events.length = 0;
    state.events.push(published);
    if (state.events.length > MAX_EVENTS_PER_CHAT) state.events.shift();
    for (const listener of state.listeners) listener(published);
    for (const listener of this.allListeners) listener(chatId, event);
    return published;
  }

  subscribeFrom(
    chatId: ChatId,
    after: ChatEventCursor | undefined,
    listener: (published: PublishedChatEvent) => void,
  ): ChatEventSubscription {
    const state = this.stateFor(chatId);
    const cursor = { epoch: this.epoch, revision: state.revision };
    if (!after || this.hasGap(state, after)) return { kind: "snapshot-required", cursor };

    state.listeners.add(listener);
    let active = true;
    return {
      kind: "replay",
      subscriptionId: randomUUID(),
      cursor,
      events: state.events.filter(
        ({ cursor: eventCursor }) => eventCursor.revision > after.revision,
      ),
      unsubscribe: () => {
        if (!active) return;
        active = false;
        state.listeners.delete(listener);
      },
    };
  }

  private hasGap(state: ChatEventState, after: ChatEventCursor): boolean {
    if (after.epoch !== this.epoch || after.revision > state.revision) return true;
    const firstRevision = state.events[0]?.cursor.revision ?? state.revision + 1;
    return after.revision < firstRevision - 1;
  }

  private stateFor(chatId: ChatId): ChatEventState {
    let state = this.chats.get(chatId);
    if (!state) {
      state = { revision: 0, events: [], listeners: new Set() };
      this.chats.set(chatId, state);
    }
    return state;
  }
}

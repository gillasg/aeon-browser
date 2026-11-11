// Run cards go out on the chat stream the UI already listens to.

import type { ChatId, PiSessionEvent } from "@aeon/domain";
import type { RunCard } from "@aeon/protocol";
import type { ChatEventHub } from "./chat-event-hub.js";

export function runCardEvent(card: RunCard): PiSessionEvent {
  return { kind: "run-card", card };
}

export function publishRunCard(hub: ChatEventHub, card: RunCard): void {
  hub.publish(card.chatId as ChatId, runCardEvent(card));
}

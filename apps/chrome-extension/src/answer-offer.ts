import type { AnswerOffer, TranscriptRow } from "@aeon/ui";
import { submitComposerMessage } from "./chat-composer-submit.js";
import type { UiClient } from "./ui-client-core.js";

export function latestAnswerText(rows: readonly TranscriptRow[]): string {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || row.kind !== "entry" || row.entry.message?.role !== "assistant") continue;
    const text = row.entry.message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

export async function sendAnswerOffer(input: {
  client: UiClient | undefined;
  chatId: string;
  offer: AnswerOffer;
  wasRunning: boolean;
  answerText: string;
  onError(message: string): void;
  pin(text: string): Promise<void>;
}): Promise<void> {
  try {
    if (input.offer.action === "pin") {
      await input.pin(input.answerText);
      return;
    }
    await sendAnswerText(input, input.offer.followUp);
  } catch (error) {
    input.onError(error instanceof Error ? error.message : "That offer could not be sent.");
  }
}

export async function sendAnswerText(
  input: {
    client: UiClient | undefined;
    chatId: string;
    wasRunning: boolean;
    onError(message: string): void;
  },
  text: string,
): Promise<void> {
  const message = text.trim();
  if (!message || !input.client) return;
  await submitComposerMessage({
    client: input.client,
    chatId: input.chatId,
    requestId: crypto.randomUUID(),
    text: message,
    mode: "followUp",
    wasRunning: input.wasRunning,
    attachments: [],
    browserContext: null,
    typedByUser: true,
    onError: input.onError,
  });
}

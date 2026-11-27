import type { AnswerOffer, TranscriptRow } from "@graft/ui";
import { submitComposerMessage } from "./chat-composer-submit.js";
import type { UiClient } from "./ui-client-core.js";
import { localOfferAction } from "./offer-actions.js";

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
  url?: string;
  onError(message: string): void;
  onNotice?(message: string): void;
}): Promise<void> {
  try {
    const local = await localOfferAction(input.offer, input.url);
    if (local.handled) {
      input.onNotice?.(local.notice);
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

/** The management input that marks a page's answer as wrong, or none off a web page. */
export function reportWrongInput(url: string | undefined): { site: string; quirk: string } | null {
  if (!url || !/^https?:/.test(url)) return null;
  try {
    const site = new URL(url).hostname.replace(/^www\./, "");
    return site ? { site, quirk: "The user marked this answer as wrong." } : null;
  } catch {
    return null;
  }
}

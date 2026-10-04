import { additionalPages, attachAdditionalPages } from "./additional-page-context.js";
import {
  DaemonUiRequestSchema,
  type DaemonUiResponse,
  type PiBrowserContextRecord,
} from "@pippin/protocol";
import type { ComposerAttachment } from "@pippin/ui";
import type { DevUiClient } from "./dev-ui-client.js";

interface SubmitComposerMessageInput {
  client: DevUiClient;
  chatId: string;
  requestId: string;
  text: string;
  mode: "followUp" | "steer";
  wasRunning: boolean;
  attachments: readonly ComposerAttachment[];
  browserContext: PiBrowserContextRecord | null;
  onError(message: string): void;
}

export async function submitComposerMessage(input: SubmitComposerMessageInput): Promise<boolean> {
  const pages = additionalPages(input.chatId).filter(
    (page) => page.target.tabId !== input.browserContext?.target.tabId,
  );
  if (input.wasRunning && pages.length)
    throw new Error("Wait for the current response before sending tab context.");
  await attachAdditionalPages(input.client, input.chatId, pages);
  const request = createRequest(input);
  const after = input.client.send(DaemonUiRequestSchema.parse(request));
  const response = await input.client.waitFor(
    (item) => isSubmitResponse(item, input.requestId, input.wasRunning),
    after,
  );
  if (response.kind === "command.failed") {
    input.onError(`${response.code} · ${response.message}`);
    return false;
  }
  if (
    input.wasRunning &&
    (response.kind !== "command.completed" || response.result.kind !== "chat.queued")
  ) {
    input.onError("Pi did not confirm the queued message.");
    return false;
  }
  return true;
}

function createRequest(input: SubmitComposerMessageInput) {
  const payload = {
    chatId: input.chatId,
    browserContexts: additionalPages(input.chatId).filter(
      (page) => page.target.tabId !== input.browserContext?.target.tabId,
    ),
    text: input.text,
    ...(input.attachments.length ? { attachments: [...input.attachments] } : {}),
    ...(input.browserContext ? { browserContext: input.browserContext } : {}),
  };
  return input.wasRunning
    ? {
        kind: "command" as const,
        requestId: input.requestId,
        operation: "chat.queue" as const,
        payload: { ...payload, mode: input.mode },
      }
    : {
        kind: "command" as const,
        requestId: input.requestId,
        operation: "chat.submit" as const,
        payload,
      };
}

function isSubmitResponse(item: DaemonUiResponse, requestId: string, wasRunning: boolean): boolean {
  if (
    item.kind !== "command.started" &&
    item.kind !== "command.completed" &&
    item.kind !== "command.failed"
  )
    return false;
  if (item.requestId !== requestId) return false;
  return wasRunning ? item.kind !== "command.started" : item.kind !== "command.completed";
}

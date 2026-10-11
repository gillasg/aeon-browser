import {
  DaemonUiRequestSchema,
  type ChatEventCursorDto,
  type DaemonUiResponse,
} from "@aeon/protocol";
import type { UiClient } from "./ui-client-core.js";
export async function subscribeSavedChat(
  client: UiClient,
  chatId: string,
  cursor: ChatEventCursorDto | undefined,
): Promise<DaemonUiResponse> {
  const requestId = crypto.randomUUID();
  const after = client.send(
    DaemonUiRequestSchema.parse({
      kind: "chat.subscribe",
      requestId,
      chatId,
      ...(cursor ? { afterCursor: cursor } : {}),
    }),
  );
  return await client.waitFor(
    (message) =>
      (message.kind === "chat.snapshot" ||
        message.kind === "chat.resumed" ||
        message.kind === "chat.subscription-failed") &&
      message.requestId === requestId,
    after,
  );
}

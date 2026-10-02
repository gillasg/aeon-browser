import {
  DaemonUiRequestSchema,
  type ChatEventCursorDto,
  type DaemonUiResponse,
} from "@pippin/protocol";
import type { DevUiClient } from "./dev-ui-client.js";
export async function subscribeSavedChat(
  client: DevUiClient,
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
    60_000,
  );
}

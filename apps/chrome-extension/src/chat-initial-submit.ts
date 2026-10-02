import { DaemonUiRequestSchema } from "@pippin/protocol";
import type { DevUiClient } from "./dev-ui-client.js";
import { takeNativeInitialSubmit } from "./ui-connection.js";
import { applyInitialChatSelection } from "./initial-chat-selection.js";

export async function submitInitialPrompt(
  chatId: string,
  client: DevUiClient | undefined,
  nativeTransport: boolean,
): Promise<boolean> {
  if (!nativeTransport || !client) return false;
  const initialSubmit = await takeNativeInitialSubmit(chatId);
  if (!initialSubmit) return false;
  await applyInitialChatSelection(client, chatId, {
    model: initialSubmit.model,
    thinkingLevel: initialSubmit.thinkingLevel,
  });
  const after = client.send(
    DaemonUiRequestSchema.parse({
      kind: "command",
      requestId: initialSubmit.requestId,
      operation: "chat.submit",
      payload: { chatId, text: initialSubmit.text, attachments: initialSubmit.attachments ?? [] },
    }),
  );
  const response = await client.waitFor(
    (message) =>
      (message.kind === "command.started" || message.kind === "command.failed") &&
      message.requestId === initialSubmit.requestId,
    after,
  );
  if (response.kind === "command.failed") throw new Error(response.message);
  if (response.kind !== "command.started" || response.chatId !== chatId)
    throw new Error("Pi did not start the first Chat prompt.");
  return true;
}

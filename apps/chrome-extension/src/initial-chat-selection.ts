import { DaemonUiRequestSchema, type DaemonUiResponse } from "@aeon/protocol";
import type { UiClient } from "./ui-client-core.js";

export interface InitialChatSelection {
  model: { provider: string; id: string };
  thinkingLevel: string;
}

export async function applyInitialChatSelection(
  client: UiClient,
  chatId: string,
  selection: InitialChatSelection,
): Promise<void> {
  await sendCommand(client, {
    operation: "chat.model",
    payload: { chatId, ...selection.model },
  });
  await sendCommand(client, {
    operation: "chat.thinking",
    payload: { chatId, level: selection.thinkingLevel },
  });
}

async function sendCommand(
  client: UiClient,
  command:
    | {
        operation: "chat.model";
        payload: { chatId: string; provider: string; id: string };
      }
    | { operation: "chat.thinking"; payload: { chatId: string; level: string } },
): Promise<void> {
  const requestId = crypto.randomUUID();
  const after = client.send(
    DaemonUiRequestSchema.parse({ kind: "command", requestId, ...command }),
  );
  // First use materializes Pi's session and configured MCP connections.
  const response = await client.waitFor(isCommandResponse(requestId), after);
  if (response.kind === "command.failed") throw new Error(response.message);
  if (response.kind !== "command.completed") throw new Error("Pi rejected the initial settings.");
}

function isCommandResponse(requestId: string) {
  return (
    message: DaemonUiResponse,
  ): message is Extract<DaemonUiResponse, { kind: "command.completed" | "command.failed" }> =>
    (message.kind === "command.completed" || message.kind === "command.failed") &&
    message.requestId === requestId;
}

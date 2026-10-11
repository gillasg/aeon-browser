import { DaemonUiRequestSchema, type DaemonUiResponse } from "@aeon/protocol";
import type { ChatComposerProps, ComposerControls } from "@aeon/ui";
import type { UiClient } from "./ui-client-core.js";
export async function sendComposerCommand(
  client: UiClient | undefined,
  request: Record<string, unknown>,
): Promise<DaemonUiResponse> {
  if (!client) throw new Error("The local daemon is unavailable.");
  const requestId = crypto.randomUUID();
  const after = client.send(
    DaemonUiRequestSchema.parse({ kind: "command", requestId, ...request }),
  );
  const response = await client.waitFor(
    (message) =>
      (message.kind === "command.completed" || message.kind === "command.failed") &&
      message.requestId === requestId,
    after,
  );
  if (response.kind === "command.failed") throw new Error(response.message);
  return response;
}
type QueueAction = NonNullable<ChatComposerProps["onQueueAction"]>;
export async function editComposerQueue(
  controls: ComposerControls | null,
  chatId: string,
  mode: Parameters<QueueAction>[0],
  index: number,
  action: Parameters<QueueAction>[2],
  text: string | undefined,
  command: (request: Record<string, unknown>) => Promise<DaemonUiResponse>,
  onError: (message: string) => void,
  refresh: () => Promise<void>,
): Promise<void> {
  if (!controls) return;
  try {
    await command({
      operation: "chat.queue-edit",
      payload: {
        chatId,
        mode,
        index,
        action,
        ...(text ? { text } : {}),
        steering: controls.steeringQueue,
        followUp: controls.followUpQueue,
      },
    });
  } catch (error) {
    onError(messageOf(error));
  }
  await refresh();
}

export function contextAssociationMessage(
  status: "stale" | "lost" | "offline" | "attached",
): string {
  if (status === "stale") return "Page context is saved, but its source page has changed.";
  if (status === "lost") return "Page context is saved, but its source tab has closed.";
  if (status === "offline") return "Page context is saved; browser control is offline.";
  return "";
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "The local operation failed.";
}

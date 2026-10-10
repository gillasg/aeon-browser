import type { DaemonUiResponse, PiBrowserContextRecord } from "@aeon/protocol";
import { contextAssociationMessage } from "./composer-command.js";
export function associateComposerContext(
  record: PiBrowserContextRecord,
  chatId: string,
  associations: Map<string, Promise<void>>,
  command: (request: Record<string, unknown>) => Promise<DaemonUiResponse>,
  onError: (message: string) => void,
  onStatus: (status: "current" | "stale" | "lost" | "offline") => Promise<void>,
): Promise<void> {
  const current = associations.get(record.contextId);
  if (current) return current;
  const attaching = Promise.resolve()
    .then(() =>
      command({
        operation: "chat.attach-browser-context",
        payload: { chatId, target: record.target, url: record.url },
      }),
    )
    .then(async (response) => {
      if (
        response.kind !== "command.completed" ||
        response.result.kind !== "chat.browser-context-attached"
      )
        throw new Error("The daemon did not confirm the page association.");
      if (response.result.status !== "attached")
        onError(contextAssociationMessage(response.result.status));
      await onStatus(response.result.status === "attached" ? "current" : response.result.status);
    })
    .catch(() => {
      if (associations.get(record.contextId) === attaching) associations.delete(record.contextId);
      onError("Page context is saved, but browser control could not attach its source tab.");
    });
  associations.set(record.contextId, attaching);
  return attaching;
}

import {
  DaemonUiRequestSchema,
  PiBrowserContextRecordSchema,
  type PiBrowserContextRecord,
} from "@pippin/protocol";
import type { DevUiClient } from "./dev-ui-client.js";
export function additionalPages(chatId: string): PiBrowserContextRecord[] {
  try {
    const data: unknown = JSON.parse(
      sessionStorage.getItem("aeon-context-pages:" + chatId) ?? "[]",
    );
    return Array.isArray(data)
      ? data
          .flatMap((value) => {
            const parsed = PiBrowserContextRecordSchema.safeParse(value);
            return parsed.success ? [parsed.data] : [];
          })
          .slice(0, 8)
      : [];
  } catch {
    return [];
  }
}
export async function attachAdditionalPages(
  client: DevUiClient,
  chatId: string,
  pages: PiBrowserContextRecord[],
): Promise<void> {
  for (const page of pages) {
    const requestId = crypto.randomUUID();
    const after = client.send(
      DaemonUiRequestSchema.parse({
        kind: "command",
        requestId,
        operation: "chat.attach-browser-context",
        payload: { chatId, target: page.target, url: page.url },
      }),
    );
    const response = await client.waitFor(
      (item) =>
        (item.kind === "command.completed" || item.kind === "command.failed") &&
        item.requestId === requestId,
      after,
    );
    if (
      response.kind !== "command.completed" ||
      response.result.kind !== "chat.browser-context-attached" ||
      response.result.status !== "attached"
    )
      throw new Error("Could not attach selected tab. Remove its chip and select it again.");
  }
}

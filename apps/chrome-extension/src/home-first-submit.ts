import { PiBrowserContextRecordSchema, type PiAttachmentDto } from "@aeon/protocol";
import type { UiClient } from "./ui-client-core.js";
import { additionalPages } from "./additional-page-context.js";
import { projectDraftPayload } from "./project-bridge.js";

export async function startHomePrompt(
  client: UiClient,
  initial: {
    text: string;
    model: { provider: string; id: string };
    thinkingLevel: string;
    attachments: PiAttachmentDto[];
  },
): Promise<string> {
  const requestId = crypto.randomUUID();
  const after = client.send({
    kind: "command",
    requestId,
    operation: "chat.create",
    payload: {
      ...projectDraftPayload(),
      initialSubmit: { ...initial, browserContexts: homePages() },
    },
  });
  const response = await client.waitFor(
    (item) =>
      (item.kind === "command.completed" || item.kind === "command.failed") &&
      item.requestId === requestId,
    after,
  );
  if (response.kind === "command.failed") throw new Error(response.message);
  if (response.kind !== "command.completed" || response.result.kind !== "chat.created")
    throw new Error("Unexpected Chat creation response.");
  return response.result.chat.chatId;
}

function homePages() {
  const pages = additionalPages("draft");
  const raw = sessionStorage.getItem("aeon-panel-page");
  if (raw) {
    try {
      const parsed = PiBrowserContextRecordSchema.safeParse(JSON.parse(raw));
      if (parsed.success && !pages.some((page) => page.contextId === parsed.data.contextId))
        pages.unshift(parsed.data);
    } catch {
      /* Ignore a stale local draft; explicit selected chips remain authoritative. */
    }
  }
  return pages.slice(0, 8);
}

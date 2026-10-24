import { additionalPages, attachAdditionalPages } from "./additional-page-context.js";
import { readChatContext, removeChatContext } from "./browser-context-storage.js";
import { DaemonUiRequestSchema } from "@aeon/protocol";
import type { UiClient } from "./ui-client-core.js";
import { takeNativeInitialSubmit } from "./ui-connection.js";
import { applyInitialChatSelection } from "./initial-chat-selection.js";

export async function submitInitialPrompt(
  chatId: string,
  client: UiClient | undefined,
  nativeTransport: boolean,
): Promise<boolean> {
  if (!nativeTransport || !client) return false;
  const staged = sessionStorage.getItem("aeon-panel-initial:" + chatId);
  const initialSubmit = staged
    ? (JSON.parse(staged) as NonNullable<Awaited<ReturnType<typeof takeNativeInitialSubmit>>>)
    : await takeNativeInitialSubmit(chatId);
  if (staged) sessionStorage.removeItem("aeon-panel-initial:" + chatId);
  const context = await readChatContext(chatId);
  if (!initialSubmit) return false;
  await applyInitialChatSelection(client, chatId, {
    model: initialSubmit.model,
    thinkingLevel: initialSubmit.thinkingLevel,
  });
  const browserContexts = additionalPages(chatId).filter(
    (page) => page.target.tabId !== context?.context.target.tabId,
  );
  await attachAdditionalPages(client, chatId, browserContexts);
  const after = client.send(
    DaemonUiRequestSchema.parse({
      kind: "command",
      requestId: initialSubmit.requestId,
      operation: "chat.submit",
      payload: {
        chatId,
        browserContexts,
        text: initialSubmit.text,
        // The panel's first prompt is what the user typed there; the page context is separate.
        typedByUser: true,
        attachments: initialSubmit.attachments ?? [],
        ...(context ? { browserContext: context.context } : {}),
      },
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
  if (document.body.dataset.host !== "panel") await clearConsumedContext(chatId, context);
  return true;
}

async function clearConsumedContext(
  chatId: string,
  context: Awaited<ReturnType<typeof readChatContext>>,
): Promise<void> {
  if (context) await removeChatContext(chatId, context.context.contextId);
}

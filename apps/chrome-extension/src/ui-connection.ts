import type { UiClient } from "./ui-client-core.js";
import { connectNativeUi } from "./native-ui-client.js";
import {
  NativeTakeInitialSubmitResponseSchema,
  pageGrantErrorMessage,
} from "./native-extension-message.js";
import type { PageGrantScope } from "@pippin/protocol";
import type { PiAttachmentDto } from "@pippin/protocol";

interface OpenChatOptions {
  targetWindowId?: number;
  reuseCurrentTab?: boolean;
  initialSubmit?: {
    requestId: string;
    text: string;
    model: { provider: string; id: string };
    thinkingLevel: string;
    attachments?: PiAttachmentDto[];
  };
}

export type PageConnection =
  | {
      kind: "connected";
      client: UiClient;
    }
  | { kind: "failed"; code: string };

export async function connectPage(scope: PageGrantScope): Promise<PageConnection> {
  const result = await connectNativeUi(scope);
  return result.kind === "connected"
    ? { kind: "connected", client: result.client }
    : { kind: "failed", code: result.code };
}

export async function openExtensionChat(
  chatId: string,
  options: OpenChatOptions = {},
): Promise<{ focusedExisting: boolean }> {
  return openNativeChat(chatId, options);
}

async function openNativeChat(
  chatId: string,
  options: OpenChatOptions,
): Promise<{ focusedExisting: boolean }> {
  const response = await chrome.runtime.sendMessage({
    kind: "pippin.native.open-chat",
    chatId,
    ...options,
  });
  if (!response?.ok) throw new Error(response?.code ?? "TAB_OPEN_FAILED");
  return { focusedExisting: response.focusedExisting };
}

export async function takeNativeInitialSubmit(chatId: string): Promise<
  | {
      requestId: string;
      text: string;
      model: { provider: string; id: string };
      thinkingLevel: string;
      attachments?: PiAttachmentDto[];
    }
  | undefined
> {
  const response = NativeTakeInitialSubmitResponseSchema.safeParse(
    await chrome.runtime.sendMessage({ kind: "pippin.native.take-initial-submit", chatId }),
  );
  if (!response.success) throw new Error("The initial Chat prompt handoff was invalid.");
  if (!response.data.ok) {
    if (response.data.code === "INITIAL_SUBMIT_UNAVAILABLE") return undefined;
    throw new Error("The initial Chat prompt handoff was rejected.");
  }
  return {
    requestId: response.data.requestId,
    text: response.data.text,
    model: response.data.model,
    thinkingLevel: response.data.thinkingLevel,
    ...(response.data.attachments ? { attachments: response.data.attachments } : {}),
  };
}

export function connectionErrorMessage(code: string): string {
  return pageGrantErrorMessage(code);
}

export async function connectCatalogPage(current?: UiClient): Promise<UiClient | undefined> {
  if (current?.socket.readyState === WebSocket.OPEN) return current;
  const result = await connectPage({ kind: "catalog" });
  return result.kind === "connected" ? result.client : undefined;
}

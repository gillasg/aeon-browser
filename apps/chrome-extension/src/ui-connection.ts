import {
  DevPageGrantResponseSchema,
  DevTakeChatGrantResponseSchema,
} from "./dev-extension-message.js";
import type { DevUiClient, UiConnectResult } from "./dev-ui-client.js";
import { connectDevUi } from "./dev-ui-client.js";
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
      client: DevUiClient;
      developmentGrant: string;
    }
  | { kind: "failed"; code: string };

export async function connectPage(scope: PageGrantScope): Promise<PageConnection> {
  if (__PIPPIN_NATIVE_TRANSPORT__) {
    const result = await connectNativeUi(scope);
    return result.kind === "connected"
      ? { kind: "connected", client: result.client, developmentGrant: "" }
      : { kind: "failed", code: result.code };
  }

  const grantResponse =
    scope.kind === "chat"
      ? DevTakeChatGrantResponseSchema.safeParse(
          await chrome.runtime.sendMessage({
            kind: "pippin.dev.take-chat-grant",
            chatId: scope.chatId,
          }),
        )
      : DevPageGrantResponseSchema.safeParse(
          await chrome.runtime.sendMessage({ kind: "pippin.dev.get-page-grant" }),
        );
  if (!grantResponse.success) return { kind: "failed", code: "INVALID_GRANT_RESPONSE" };
  if (!grantResponse.data.ok) return { kind: "failed", code: grantResponse.data.code };
  const grant = grantResponse.data.connectionGrant;
  const result: UiConnectResult = await connectDevUi(grant);
  return result.kind === "connected"
    ? { kind: "connected", client: result.client, developmentGrant: grant }
    : { kind: "failed", code: result.code };
}

export async function openExtensionChat(
  chatId: string,
  options: OpenChatOptions = {},
  developmentGrant = "",
): Promise<{ focusedExisting: boolean }> {
  return __PIPPIN_NATIVE_TRANSPORT__
    ? openNativeChat(chatId, options)
    : openDevelopmentChat(chatId, options, developmentGrant);
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

async function openDevelopmentChat(
  chatId: string,
  options: OpenChatOptions,
  developmentGrant: string,
): Promise<{ focusedExisting: boolean }> {
  if (!developmentGrant) throw new Error("The development grant is unavailable.");
  const response = await chrome.runtime.sendMessage({
    kind: "pippin.dev.open-chat",
    chatId,
    connectionGrant: developmentGrant,
    ...(options.targetWindowId !== undefined ? { targetWindowId: options.targetWindowId } : {}),
    ...(options.reuseCurrentTab !== undefined ? { reuseCurrentTab: options.reuseCurrentTab } : {}),
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
  if (!__PIPPIN_NATIVE_TRANSPORT__) return undefined;
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
  return __PIPPIN_NATIVE_TRANSPORT__ ? pageGrantErrorMessage(code) : code;
}

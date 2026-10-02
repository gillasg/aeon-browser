import { clearAutoPrompt, readChatContext } from "./browser-context-storage.js";
import { NativeClaimBrowserContextSubmitResponseSchema } from "./native-extension-message.js";
import { isPageScopeAllowed } from "./native-worker-tabs.js";

const claimedContextSubmissions = new Set<string>();

export async function claimBrowserContextSubmit(
  sender: chrome.runtime.MessageSender,
  chatId: string,
  invocationId: string,
): Promise<unknown> {
  if (!isPageScopeAllowed(sender, { kind: "chat", chatId })) return invalidSender();
  const claimKey = `${chatId}/${invocationId}`;
  if (claimedContextSubmissions.has(claimKey)) return alreadyClaimed();
  claimedContextSubmissions.add(claimKey);
  const draft = await readChatContext(chatId);
  if (draft?.invocationId !== invocationId || !draft.autoPrompt) return unavailable();
  const prompt = draft.autoPrompt;
  await clearAutoPrompt(chatId, invocationId);
  return NativeClaimBrowserContextSubmitResponseSchema.parse({ ok: true, prompt });
}

function invalidSender() {
  return NativeClaimBrowserContextSubmitResponseSchema.parse({ ok: false, code: "INVALID_SENDER" });
}

function alreadyClaimed() {
  return NativeClaimBrowserContextSubmitResponseSchema.parse({
    ok: false,
    code: "ALREADY_CLAIMED",
  });
}

function unavailable() {
  return NativeClaimBrowserContextSubmitResponseSchema.parse({ ok: false, code: "UNAVAILABLE" });
}

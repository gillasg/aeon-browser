import { BrowserContextDraftSchema, type PiBrowserContextRecord } from "@aeon/protocol";
import { NativeClaimBrowserContextSubmitResponseSchema } from "./native-extension-message.js";

interface BrowserContextComposer {
  setBrowserContext(record: PiBrowserContextRecord | null): void;
  sendPrompt(text: string): Promise<boolean>;
}

interface ApplyBrowserContextDraftInput {
  value: unknown;
  chatId: string;
  composer: BrowserContextComposer;
  nativeTransport: boolean;
  connected: boolean;
  running: boolean;
  hasPendingSubmits: boolean;
  attemptedInvocations: Set<string>;
  showError(message: string): void;
}

type BrowserContextDraftHandlerOptions = Omit<
  ApplyBrowserContextDraftInput,
  "value" | "connected" | "running" | "hasPendingSubmits"
> & {
  readRuntimeState(): Pick<
    ApplyBrowserContextDraftInput,
    "connected" | "running" | "hasPendingSubmits"
  >;
};

export function createBrowserContextDraftHandler(
  options: BrowserContextDraftHandlerOptions,
): (value: unknown) => Promise<void> {
  return (value) => applyBrowserContextDraft({ ...options, ...options.readRuntimeState(), value });
}

export async function applyBrowserContextDraft(
  input: ApplyBrowserContextDraftInput,
): Promise<void> {
  const parsed = BrowserContextDraftSchema.safeParse(input.value);
  const draft = parsed.success ? parsed.data : undefined;
  input.composer.setBrowserContext(draft?.context ?? null);
  if (!draft?.autoPrompt || !canSubmitContext(input, draft.invocationId)) return;
  input.attemptedInvocations.add(draft.invocationId);
  const response = NativeClaimBrowserContextSubmitResponseSchema.safeParse(
    await chrome.runtime.sendMessage({
      kind: "aeon.native.claim-browser-context-submit",
      chatId: input.chatId,
      invocationId: draft.invocationId,
    }),
  );
  if (response.success && response.data.ok) await input.composer.sendPrompt(response.data.prompt);
  else if (!response.success) input.showError("Aeon could not claim the page summary request.");
}

function canSubmitContext(input: ApplyBrowserContextDraftInput, invocationId: string): boolean {
  return (
    input.nativeTransport &&
    input.connected &&
    !input.running &&
    !input.hasPendingSubmits &&
    !input.attemptedInvocations.has(invocationId)
  );
}

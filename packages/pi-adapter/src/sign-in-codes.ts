import { codeIn } from "@browserkit/engine/native-browser-inbox-code";

// A one-time sign-in code the agent read is a secret, the same way a password is: every form it
// takes in text is replaced in the answer. The tool result itself stays, so the model can still
// type the code. Order numbers and payment approvals are not codes (codeIn skips them).

const MAX = 40;

/** Codes seen in this session's tool results. */
export class SignInCodes {
  private readonly codes = new Set<string>();

  note(text: string): void {
    const code = codeIn(text);
    if (!code || code.length < 4) return;
    this.codes.add(code);
    while (this.codes.size > MAX) this.codes.delete(this.codes.values().next().value as string);
  }

  mask(text: string): string {
    if (!this.codes.size || !text) return text;
    let out = text;
    for (const value of this.codes)
      for (const form of formsOf(value))
        if (out.includes(form)) out = out.split(form).join("[removed]");
    return out;
  }
}

// A code is a secret for one chat, not for one resource loader: a resource reload rebuilds the
// extension (and its own store), and two chats must not mask each other's answers. The projection
// layer masks streaming updates from this per-chat store, so digits cannot flash before
// message_end. Codes noted before a reload still apply to the rest of that chat.
const MAX_CHATS = 60;
const chats = new Map<string, SignInCodes>();

/** The code store for one chat, created on first use and kept across resource reloads. */
export function signInCodes(chatId: string): SignInCodes {
  let store = chats.get(chatId);
  if (!store) {
    store = new SignInCodes();
    if (chats.size >= MAX_CHATS) {
      const oldest = chats.keys().next().value;
      if (oldest !== undefined) chats.delete(oldest);
    }
    chats.set(chatId, store);
  }
  return store;
}

/** A text/thinking block after masking; the object is reused when nothing changed. */
export function maskAnswerBlock<T extends { type?: string; text?: string; thinking?: string }>(
  codes: SignInCodes,
  block: T,
): T {
  if (block.type === "text" && block.text) {
    const text = codes.mask(block.text);
    return text === block.text ? block : { ...block, text };
  }
  if (block.type === "thinking" && block.thinking) {
    const thinking = codes.mask(block.thinking);
    return thinking === block.thinking ? block : { ...block, thinking };
  }
  return block;
}

/** Every way a value commonly shows up in text: as typed, URL- or form-encoded, JSON, base64. */
function formsOf(value: string): string[] {
  const forms = new Set([
    value,
    encodeURIComponent(value),
    encodeURIComponent(value).replace(/%20/g, "+"),
    new URLSearchParams({ v: value }).toString().slice(2),
    JSON.stringify(value).slice(1, -1),
  ]);
  const bytes = new TextEncoder().encode(value);
  if ([...bytes].every((byte) => byte < 128))
    forms.add(btoa(String.fromCharCode(...bytes)).replace(/=+$/, ""));
  return [...forms].filter((form) => form.length >= 4);
}

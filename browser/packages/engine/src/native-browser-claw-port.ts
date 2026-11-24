// What the storage, download, freeze and dry-run claws need from a tab: send a CDP command and
// hear its events. A port touches nothing until a claw sends on it, so a tab nobody queries pays
// nothing. Tests drive the claws with a fake port; the extension builds one per tab from the
// shared debugger session (see native-browser-claws.ts).

export type ClawEvent = (method: string, params: Record<string, unknown>) => void;

export interface ClawPort {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Subscribes to this tab's CDP events; the returned function unsubscribes. */
  on(listener: ClawEvent): () => void;
}

const REDACTED = "[redacted]";
const SECRET_KEY =
  /(pass(word|wd)?|pwd|secret|token|auth|bearer|cookie|session|sid$|csrf|xsrf|api[-_]?key|apikey|jwt|credential|private[-_]?key|signature|otp)/i;
const SECRET_TEXT: readonly RegExp[] = [
  /eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*/g,
  /\b(Bearer|Basic|Token)\s+[\w.~+/=-]{8,}/gi,
  /\b(sk|pk|rk)[-_](live|test|proj)?[-_]?[A-Za-z0-9]{16,}/g,
  /\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[\w-]{10,}/g,
  /\bAIza[\w-]{30,}/g,
];

/** Hides tokens, JWTs, keys and credentials inside free text. */
export function scrubText(text: string): string {
  let out = text;
  for (const pattern of SECRET_TEXT) out = out.replace(pattern, REDACTED);
  return out.replace(
    /([?&;\s"']|^)((?:access_|refresh_|id_)?token|api[-_]?key|password|secret|session|sig|auth)=([^&;\s"']+)/gi,
    (_m, lead: string, key: string) => `${lead}${key}=${REDACTED}`,
  );
}

/** True when a key name (a field, header, cookie or storage key) holds a secret by its name. */
export const secretKey = (key: string): boolean => SECRET_KEY.test(key);

/** Deep copy with every secret-named field and secret-looking string redacted. */
export function scrubValue<T>(value: T, depth = 0): T {
  if (typeof value === "string") return scrubText(value) as T;
  if (!value || typeof value !== "object" || depth > 12) return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>))
    out[key] =
      secretKey(key) && item !== null && item !== undefined && typeof item !== "object"
        ? REDACTED
        : scrubValue(item, depth + 1);
  return out as T;
}

/** A name/value pair (storage item, header) with the value hidden when the name is secret. */
export function scrubPair(name: string, value: string): string {
  return secretKey(name) ? REDACTED : scrubText(value);
}

/** A URL safe to report: secret-named query values and fragments hidden. */
export function scrubUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()])
      if (secretKey(key) || /^(code|key|sig|state)$/i.test(key))
        parsed.searchParams.set(key, REDACTED);
    if (parsed.hash.length > 1) parsed.hash = "";
    parsed.username = "";
    parsed.password = "";
    return scrubText(parsed.href);
  } catch {
    return scrubText(url);
  }
}

/** A bounded FIFO: pushing past `max` drops the oldest. */
export class Ring<T> {
  private items: T[] = [];
  dropped = 0;
  constructor(private readonly max: number) {}
  push(item: T): void {
    this.items.push(item);
    while (this.items.length > this.max) {
      this.items.shift();
      this.dropped += 1;
    }
  }
  list(): T[] {
    return [...this.items];
  }
  clear(): void {
    this.items = [];
    this.dropped = 0;
  }
  get size(): number {
    return this.items.length;
  }
}

export const clampLimit = (value: unknown, fallback: number, max: number): number => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
};

/** sha256 of bytes as lowercase hex (WebCrypto: service worker and Node alike). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Evaluates an expression in the page and returns its value. */
export async function evaluate<T>(port: ClawPort, expression: string): Promise<T> {
  const reply = await port.send<{
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (reply.exceptionDetails)
    throw new Error(
      "CODE_ERROR: " +
        scrubText(
          reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? "",
        ),
    );
  return reply.result?.value as T;
}

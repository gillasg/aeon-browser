// Passwords and one-time codes the agent must never read: the ones a password-manager sign-in
// types, and the ones a person typed into a page the agent works in. Everything that leaves the
// engine for agent code (step results, errors, call answers, network recordings) has them
// replaced, whatever field they sit in. They are kept for the browser session, in memory only
// (chrome.storage.session survives a service worker restart, never touches disk and is closed to
// pages and the sandbox), so a value read back an hour later is still removed.

const KEY = "aeon-secrets";
const MAX = 200;
const secrets = new Set<string>();
let loaded: Promise<void> | undefined;

function session(): chrome.storage.StorageArea | undefined {
  return (globalThis as { chrome?: typeof chrome }).chrome?.storage?.session;
}

function load(): Promise<void> {
  loaded ??= (async () => {
    const stored = await session()
      ?.get(KEY)
      .catch(() => undefined);
    const values = stored?.[KEY];
    if (Array.isArray(values)) for (const value of values) secrets.add(String(value));
  })();
  return loaded;
}

export function rememberSecrets(values: readonly string[]): void {
  let added = false;
  for (const value of values)
    if (value.length >= 4 && !secrets.has(value)) {
      secrets.add(value);
      added = true;
    }
  if (!added) return;
  while (secrets.size > MAX) secrets.delete(secrets.values().next().value as string);
  void load().then(() =>
    session()
      ?.set({ [KEY]: [...secrets] })
      .catch(() => undefined),
  );
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
  forms.add(btoa(String.fromCharCode(...new TextEncoder().encode(value))).replace(/=+$/, ""));
  return [...forms].filter((form) => form.length >= 4);
}

export function hideSecrets(text: string): string {
  if (!secrets.size || !text) return text;
  let out = text;
  for (const value of secrets)
    for (const form of formsOf(value))
      if (out.includes(form)) out = out.split(form).join("[removed]");
  return out;
}

function scrub(value: unknown, depth: number): unknown {
  if (typeof value === "string") return hideSecrets(value);
  if (!value || typeof value !== "object" || depth > 40) return value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[hideSecrets(key)] = scrub(item, depth + 1);
  return out;
}

/** The value with every remembered secret removed from every string in it. */
export async function scrubSecrets<T>(value: T): Promise<T> {
  await load();
  return secrets.size ? (scrub(value, 0) as T) : value;
}

/** An error whose message no longer carries a secret. */
export async function scrubError(error: unknown): Promise<unknown> {
  await load();
  if (!secrets.size || !(error instanceof Error)) return error;
  error.message = hideSecrets(error.message);
  if (error.stack) error.stack = hideSecrets(error.stack);
  return error;
}

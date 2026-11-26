/** What a callable thing does. An override always wins over inference. */
export type CallEffect = "read" | "write" | "irreversible";

const IRREVERSIBLE = /\b(payment|checkout|delete[- ]account|send|submit)\b/i;

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isCallEffect(value: unknown): value is CallEffect {
  return value === "read" || value === "write" || value === "irreversible";
}

/**
 * GET (and HEAD, OPTIONS) is read. POST, PUT, PATCH and DELETE are write.
 * Payment, checkout, delete-account, send and submit are irreversible.
 */
export function inferEffect(input: {
  method?: string;
  text?: string;
  override?: unknown;
  fallback?: CallEffect;
  /** How the operation was classified when mapped: "read" makes a read-only POST a read. */
  kind?: string;
}): CallEffect {
  if (isCallEffect(input.override)) return input.override;
  if (input.text && IRREVERSIBLE.test(input.text)) return "irreversible";
  if (input.kind === "read") return "read";
  const method = (input.method ?? "").toUpperCase();
  if (READ_METHODS.has(method)) return "read";
  if (WRITE_METHODS.has(method)) return "write";
  return input.fallback ?? "read";
}

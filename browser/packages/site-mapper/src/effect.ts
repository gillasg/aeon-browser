// What a callable thing does. An override always wins. Keep the rules in step with
// packages/domain/src/effect.ts (this package cannot import it).

export type CallEffect = "read" | "write" | "irreversible";

const IRREVERSIBLE = /\b(payment|checkout|delete[- ]account|send|submit)\b/i;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isCallEffect(value: unknown): value is CallEffect {
  return value === "read" || value === "write" || value === "irreversible";
}

/** GET (and HEAD, OPTIONS) is read. POST, PUT, PATCH and DELETE are write.
 * Payment, checkout, delete-account, send and submit are irreversible. */
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

export function operationEffect(operation: {
  method?: string;
  id?: string;
  path?: string;
  summary?: string;
  description?: string;
  steps?: string[];
  effect?: unknown;
  kind?: string;
  role?: string;
}): CallEffect {
  return inferEffect({
    override: operation.effect,
    method: operation.method,
    kind: operation.role === "read" ? "read" : (operation.kind ?? operation.role),
    text: [
      operation.id,
      operation.path,
      operation.summary,
      operation.description,
      ...(operation.steps ?? []),
    ]
      .filter(Boolean)
      .join(" "),
  });
}

export function abilityEffect(ability: {
  effect?: unknown;
  name?: string;
  description?: string;
  kind?: string;
}): CallEffect {
  return inferEffect({
    override: ability.effect,
    text: [ability.name, ability.description].filter(Boolean).join(" "),
    fallback: ability.kind === "write" ? "write" : "read",
  });
}

export function effectAnnotations(effect: CallEffect): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
} {
  return { readOnlyHint: effect === "read", destructiveHint: effect === "irreversible" };
}

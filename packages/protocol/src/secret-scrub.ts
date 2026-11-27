// Secret scrubbing for anything Graft hands to another agent (MCP events, task results). A key that
// names a secret loses its value; strings lose tokens, card numbers and one-time codes.

const SECRET_KEY =
  /pass(word|code|phrase)?|secret|token|otp|one[-_ ]?time|2fa|mfa|totp|cookie|authori[sz]ation|api[-_]?key|private[-_]?key|session|cvv|cvc|\bpin\b|ssn|credential/i;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const BEARER = /\b(bearer|basic|token)\s+[\w~+/.=-]{8,}/gi;
const KEY_LIKE = /\b(sk|pk|rk|ghp|gho|ghs|xox[abp]|AKIA|AIza)[\w-]{12,}/g;
const OTP_PHRASE =
  /\b(code|otp|passcode|pin|verification|one[- ]time)\b([^\d\n]{0,24})(\d{4,8})\b/gi;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const ASSIGNED = /\b(password|passwd|pwd|secret|token|api[-_]?key)\s*[:=]\s*\S+/gi;

export const REDACTED = "<redacted>";

/** One string with tokens, card numbers and one-time codes replaced. */
export function scrubSecretText(text: string): string {
  return text
    .replace(JWT, REDACTED)
    .replace(BEARER, (_match, kind: string) => `${kind} ${REDACTED}`)
    .replace(KEY_LIKE, REDACTED)
    .replace(ASSIGNED, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(OTP_PHRASE, (_match, word: string, gap: string) => `${word}${gap}${REDACTED}`)
    .replace(CARD, (match) => (luhn(match.replace(/\D/g, "")) ? REDACTED : match));
}

/** A deep copy with secret-named keys and secret-looking strings redacted. */
export function scrubSecrets<T>(value: T, depth = 0): T {
  if (typeof value === "string") return scrubSecretText(value) as T;
  if (!value || typeof value !== "object" || depth > 20) return value;
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>))
    out[key] =
      SECRET_KEY.test(key) && item !== null && typeof item !== "object"
        ? REDACTED
        : scrubSecrets(item, depth + 1);
  return out as T;
}

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19 || !/^[2-6]/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

/** A sealed-secret handle as the browser engine hands it to agent code. */
export const SEALED_HANDLE = /graft-sealed:[a-z0-9]{12}/;

/**
 * Throws SECRET_EGRESS when a value bound for an outside tool (an MCP server) carries a sealed
 * secret handle or a raw bearer/JWT credential. Ordinary arguments pass untouched.
 */
export function assertNoSealedSecrets(value: unknown, what: string, depth = 0): void {
  if (depth > 40) return;
  if (typeof value === "string") {
    const leak = SEALED_HANDLE.test(value)
      ? "a sealed secret"
      : JWT_ONE.test(value) || BEARER_ONE.test(value)
        ? "a raw credential"
        : undefined;
    if (leak)
      throw new Error(
        `SECRET_EGRESS: ${what} carries ${leak}. Sealed secrets never leave for an outside tool; ` +
          `pass the data the tool needs, not cookies or tokens.`,
      );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    assertNoSealedSecrets(key, what, depth + 1);
    assertNoSealedSecrets(item, what, depth + 1);
  }
}

const JWT_ONE = /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/;
const BEARER_ONE = /\bBearer\s+[\w~+/.=-]{12,}/;

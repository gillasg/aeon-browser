// Fields a request body carries with the same value every time it was recorded (`"channel":
// "web"`, `"version": 2`). A caller never needs to pass them, so replay fills them in and the
// operation's inputs list only what varies. Anything that looks like a secret or a minted value
// is left out: a session token repeated across one recording is not a constant of the API.

type Scalar = string | number | boolean;

const SECRET_KEY =
  /pass|pwd|secret|token|csrf|xsrf|nonce|auth|session|signature|sig$|cookie|otp|pin$|cvv|cvc|card|key$/i;
const MINTED = /^[A-Za-z0-9+/=_-]{24,}$/;
const MAX_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isConstantValue(key: string, value: unknown): value is Scalar {
  if (SECRET_KEY.test(key)) return false;
  if (typeof value === "number" || typeof value === "boolean") return true;
  return typeof value === "string" && value.length <= MAX_LENGTH && !MINTED.test(value);
}

/** Top-level fields identical in every recorded body (at least two bodies), or undefined. */
export function bodyConstants(values: unknown[]): Record<string, Scalar> | undefined {
  if (values.length < 2 || !values.every(isRecord)) return undefined;
  const [first, ...rest] = values as Record<string, unknown>[];
  const constants: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(first as Record<string, unknown>))
    if (isConstantValue(key, value) && rest.every((other) => other[key] === value))
      constants[key] = value;
  return Object.keys(constants).length ? constants : undefined;
}

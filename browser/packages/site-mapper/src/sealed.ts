// Values a capture never holds in the clear: a sealed-secret handle the engine hands out in
// place of a secret (`graft-sealed:<id>`, as in the protocol's SEALED_HANDLE) and the scrubber's
// `<redacted>` marker. Replaying one sends garbage; seeing one means a secret was there.

export const SEALED_HANDLE = /graft-sealed:[a-z0-9]{12}/;

/** True for a sealed handle or a value the scrubber redacted. */
export function isSealedValue(value: string | undefined): boolean {
  return value !== undefined && (SEALED_HANDLE.test(value) || value.includes("<redacted>"));
}

/** One copy of a value recorded twice by early and late capture (`"web, web"` → `"web"`). */
export function undoubled(value: string): string {
  const parts = value.split(", ");
  return parts.length > 1 && parts.every((part) => part === parts[0]) ? (parts[0] ?? value) : value;
}

// Reading a response for what it is: a success, a fetch failure in the page, a refusal below
// HTTP, a DNS miss, or data plus the notes of the transport that finally answered.

import type { RuntimeResponse } from "./request.js";

export function isOk(response: RuntimeResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

/** A request that failed before the site answered: a fetch error in the page, not an HTTP status. */
export function isFetchFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to fetch|NetworkError|Load failed|fetch failed|TypeError: fetch/i.test(message);
}

/** A request that failed below HTTP (reset, TLS refusal, timeout): a browser may still get in. */
export function isNetworkRefusal(error: unknown): boolean {
  const text =
    String((error as { cause?: { code?: string } })?.cause?.code ?? "") + " " + String(error);
  return /ECONNRESET|EPROTO|ERR_SSL|UND_ERR_SOCKET|ECONNREFUSED|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|TimeoutError|aborted|fetch failed|socket hang up|other side closed/i.test(
    text,
  );
}

/** The name did not resolve: no browser can reach it either. */
export function isDnsFailure(error: unknown): boolean {
  const text =
    String((error as { cause?: { code?: string } })?.cause?.code ?? "") + " " + String(error);
  return /ENOTFOUND|EAI_AGAIN|ENOENT/i.test(text);
}

/** The operation's data, with the response's notes when it had to take another transport. */
export function withNotes(response: RuntimeResponse): unknown {
  const value = response.json ?? response.text;
  if (!response.notes?.length || !value || typeof value !== "object" || Array.isArray(value))
    return value;
  const existing = (value as { notes?: unknown }).notes;
  return {
    ...value,
    notes: [...(Array.isArray(existing) ? existing : []), ...response.notes],
  };
}

// Passive network ring buffer: the last windowMs (60 s by default) of requests on one tab, kept as
// metadata plus a short scrubbed preview. Nothing exists until page.ringNetwork.start(): no state,
// no subscription. Every helper here is pure and self-contained so the sandbox embeds it by source.

export interface RingOptions {
  windowMs?: number;
  maxEntries?: number;
  previewBytes?: number;
}

export interface RingEntry {
  at: number;
  id: string;
  method: string;
  url: string;
  status?: number;
  type?: string;
  mimeType?: string;
  failed?: string;
  preview?: string;
}

export interface RingState {
  windowMs: number;
  maxEntries: number;
  previewBytes: number;
  entries: RingEntry[];
}

export interface RingFilter {
  sinceMs?: number;
  url?: string;
  method?: string;
  status?: number;
}

const RING_SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, "[redacted-jwt]"],
  [
    /("?(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|auth|session|cookie|cvv|cvc|card[_-]?number)[A-Za-z_-]*"?\s*[:=]\s*)("[^"]*"|[^\s&,;}"]+)/gi,
    "$1[redacted]",
  ],
  [/\b(?:\d[ -]?){13,19}\b/g, "[redacted-number]"],
];

/** Text with bearer tokens, JWTs, secret-named values and card-like numbers masked. */
export function ringScrub(text: string): string {
  let out = String(text);
  for (const [pattern, replacement] of RING_SECRET_PATTERNS)
    out = out.replace(pattern, replacement);
  return out;
}

/** A URL with secret-looking query values masked. */
export function ringScrubUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()])
      if (/pass|secret|token|key|auth|session|sig|code/i.test(key))
        parsed.searchParams.set(key, "[redacted]");
    return parsed.toString();
  } catch {
    return ringScrub(url);
  }
}

export function ringCreate(options: RingOptions = {}): RingState {
  const windowMs = Math.min(
    10 * 60_000,
    Math.max(1000, Number(options.windowMs ?? 60_000) || 60_000),
  );
  const maxEntries = Math.min(
    5000,
    Math.max(1, Math.floor(Number(options.maxEntries ?? 300) || 300)),
  );
  const previewBytes = Math.min(4096, Math.max(0, Number(options.previewBytes ?? 512) || 0));
  return { windowMs, maxEntries, previewBytes, entries: [] };
}

/** Drops everything older than the window, then the oldest past maxEntries. */
export function ringEvict(state: RingState, now: number): number {
  const floor = now - state.windowMs;
  let cut = 0;
  while (cut < state.entries.length && (state.entries[cut]?.at ?? 0) < floor) cut++;
  const over = Math.max(0, state.entries.length - cut - state.maxEntries);
  const drop = cut + over;
  if (drop) state.entries.splice(0, drop);
  return drop;
}

/** Records one request, or updates it in place when its id is already there. */
export function ringPush(state: RingState, entry: Partial<RingEntry>, now: number): void {
  const id = String(entry.id ?? "");
  const known = id ? state.entries.find((row) => row.id === id) : undefined;
  if (known) {
    if (entry.status !== undefined) known.status = Number(entry.status);
    if (entry.mimeType) known.mimeType = String(entry.mimeType);
    if (entry.failed) known.failed = String(entry.failed).slice(0, 200);
    if (entry.preview !== undefined && state.previewBytes)
      known.preview = ringScrub(String(entry.preview).slice(0, state.previewBytes));
  } else {
    const row: RingEntry = {
      at: now,
      id,
      method: String(entry.method ?? "GET").toUpperCase(),
      url: ringScrubUrl(String(entry.url ?? "")),
    };
    if (entry.status !== undefined) row.status = Number(entry.status);
    if (entry.type) row.type = String(entry.type);
    if (entry.mimeType) row.mimeType = String(entry.mimeType);
    if (entry.failed) row.failed = String(entry.failed).slice(0, 200);
    if (entry.preview !== undefined && state.previewBytes)
      row.preview = ringScrub(String(entry.preview).slice(0, state.previewBytes));
    state.entries.push(row);
  }
  ringEvict(state, now);
}

/** What happened in the window, oldest first, narrowed by age, URL part, method or status. */
export function ringQuery(state: RingState, filter: RingFilter, now: number): RingEntry[] {
  ringEvict(state, now);
  const since = filter.sinceMs !== undefined ? now - Number(filter.sinceMs) : -Infinity;
  const method = filter.method ? String(filter.method).toUpperCase() : "";
  return state.entries
    .filter(
      (row) =>
        row.at >= since &&
        (!filter.url || row.url.includes(String(filter.url))) &&
        (!method || row.method === method) &&
        (filter.status === undefined || row.status === Number(filter.status)),
    )
    .map((row) => ({ ...row }));
}

/** The constants the embedded helpers read, as sandbox source. */
export const ringConstSource =
  "var RING_SECRET_PATTERNS = [" +
  RING_SECRET_PATTERNS.map(
    ([pattern, to]) => "[" + String(pattern) + ", " + JSON.stringify(to) + "]",
  ).join(", ") +
  "];";

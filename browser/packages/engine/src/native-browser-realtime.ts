// Shared parts of the real-time taps (page.streams, page.notifications): secret scrubbing, a
// bounded ring with event-driven waiters, filters, JSON shape inference and the page-script tap.
// Nothing here talks to Chrome until a tap is started for a tab.
import { send } from "./cdp/send.js";
import { hideSecrets } from "./native-browser-secrets.js";

export const RING_MAX = 200;
export const PAYLOAD_MAX = 4096;
export const WAIT_MAX = 55_000;
const REDACTED = "[redacted]";
const SECRET_KEY =
  /^(authorization|cookie|set-cookie|password|passwd|secret|client_secret|api[-_]?key|x-api-key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|auth|session|session[-_]?id|sid|signature|sig|csrf|xsrf|bearer|credential|private[-_]?key)$/i;
const TEXT_PATTERNS: [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g, REDACTED],
  [
    /\b((?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|auth|secret|password|session(?:[-_]?id)?|sid|sig|signature|key|code)=)[^&\s"';]+/gi,
    `$1${REDACTED}`,
  ],
  [
    /("(?:authorization|cookie|password|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|token|auth|session|signature)"\s*:\s*)"[^"]*"/gi,
    `$1"${REDACTED}"`,
  ],
  [/\b(cookie|set-cookie|authorization)\s*:\s*[^\r\n]+/gi, `$1: ${REDACTED}`],
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/g, REDACTED],
  [/\b(ghp|gho|ghs|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{8,}/g, REDACTED],
];

/** A string with tokens, cookies, keys and remembered passwords replaced. */
export function scrubText(text: string): string {
  let out = hideSecrets(text);
  for (const [pattern, replacement] of TEXT_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** A JSON value with secret-named fields redacted and every string scrubbed. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubText(value);
  if (!value || typeof value !== "object" || depth > 12) return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    out[key] = SECRET_KEY.test(key) && item !== null ? REDACTED : scrubValue(item, depth + 1);
  return out;
}

export type PayloadFormat = "json" | "ndjson" | "text" | "binary";
export interface Payload {
  data: string;
  bytes: number;
  truncated: boolean;
  format: PayloadFormat;
  json?: unknown;
}

function parseJson(text: string): { ok: boolean; value?: unknown } {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

function parseNdjson(text: string): unknown[] | undefined {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return undefined;
  const values: unknown[] = [];
  for (const line of lines) {
    const parsed = parseJson(line);
    if (!parsed.ok) return undefined;
    values.push(parsed.value);
  }
  return values;
}

/** SSE text framing (`event:` / `data:` lines) carried inside a WebSocket or a raw chunk. */
function sseData(text: string): string | undefined {
  if (!/^(data|event|id):/m.test(text)) return undefined;
  const data = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  return data.length ? data.join("\n") : undefined;
}

function decode(text: string): { format: PayloadFormat; json?: unknown } {
  const body = sseData(text) ?? text;
  const parsed = parseJson(body);
  if (parsed.ok) return { format: "json", json: parsed.value };
  const lines = parseNdjson(body);
  if (lines) return { format: "ndjson", json: lines };
  return { format: "text" };
}

/** Scrubs, decodes and caps one payload. Binary frames keep only their size. */
export function toPayload(raw: unknown, binary = false): Payload {
  const text = typeof raw === "string" ? raw : raw === undefined ? "" : JSON.stringify(raw);
  const bytes = new TextEncoder().encode(text).length;
  if (binary) return { data: "", bytes, truncated: bytes > 0, format: "binary" };
  const decoded = decode(text);
  const json = decoded.json === undefined ? undefined : scrubValue(decoded.json);
  const clean = json === undefined ? scrubText(text) : JSON.stringify(json);
  const truncated = clean.length > PAYLOAD_MAX;
  return {
    data: truncated ? clean.slice(0, PAYLOAD_MAX) : clean,
    bytes,
    truncated,
    format: decoded.format,
    ...(json === undefined || truncated ? {} : { json }),
  };
}

/** A compact schema: dotted key paths (two levels, arrays as []) to the JSON types seen. */
export function shapeOf(value: unknown, prefix = "", out: Record<string, string> = {}, depth = 0) {
  if (Array.isArray(value)) {
    if (!prefix) for (const item of value.slice(0, 5)) shapeOf(item, "", out, depth);
    else if (value.length && depth < 2) shapeOf(value[0], `${prefix}[]`, out, depth + 1);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out[path] = item === null ? "null" : Array.isArray(item) ? "array" : typeof item;
    if (depth < 2 && item && typeof item === "object") shapeOf(item, path, out, depth + 1);
  }
  return out;
}

/** A URL with its query dropped and id-like path segments generalised, secrets scrubbed. */
export function urlPattern(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname
      .split("/")
      .map((part) =>
        /^\d+$|^[0-9a-f]{8}-[0-9a-f-]{27,}$|^[0-9a-f]{16,}$|^[A-Za-z0-9_-]{24,}$/i.test(part)
          ? ":id"
          : part,
      )
      .join("/");
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return scrubText(url.split("?")[0] ?? url);
  }
}

export interface RealtimeItem {
  seq: number;
  at: number;
  url: string;
  kind: string;
  direction?: string;
  data: string;
  json?: unknown;
}

export interface RealtimeFilter {
  url?: string;
  regex?: boolean;
  kind?: string | string[];
  direction?: string;
  match?: string;
  field?: string;
  equals?: unknown;
  since?: number;
}

function fieldOf(json: unknown, path: string): unknown {
  let node: unknown = json;
  for (const part of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function urlMatches(item: RealtimeItem, filter: RealtimeFilter): boolean {
  if (!filter.url) return true;
  if (!filter.regex) return item.url.includes(filter.url);
  try {
    return new RegExp(filter.url).test(item.url);
  } catch {
    return false;
  }
}

function fieldMatches(item: RealtimeItem, filter: RealtimeFilter): boolean {
  if (!filter.field) return true;
  const value = fieldOf(item.json, filter.field);
  if (value === undefined) return false;
  return filter.equals === undefined || JSON.stringify(value) === JSON.stringify(filter.equals);
}

export function matchesFilter(item: RealtimeItem, filter: RealtimeFilter): boolean {
  const kinds = filter.kind === undefined ? [] : [filter.kind].flat();
  if (kinds.length && !kinds.includes(item.kind)) return false;
  if (filter.direction && item.direction !== filter.direction) return false;
  if (filter.since !== undefined && item.seq <= filter.since) return false;
  if (filter.match && !item.data.includes(filter.match)) return false;
  return urlMatches(item, filter) && fieldMatches(item, filter);
}

/** Only the filter fields a sandbox call may set, typed. */
export function readFilter(options: Record<string, unknown>): RealtimeFilter {
  const filter: RealtimeFilter = {};
  for (const key of ["url", "direction", "match", "field"] as const)
    if (typeof options[key] === "string" && options[key]) filter[key] = options[key];
  if (options.regex === true) filter.regex = true;
  if (Array.isArray(options.kind)) filter.kind = options.kind.map(String);
  else if (typeof options.kind === "string") filter.kind = options.kind;
  if ("equals" in options) filter.equals = options.equals;
  const since = Number(options.since);
  if (options.since !== undefined && Number.isFinite(since)) filter.since = since;
  return filter;
}

interface Waiter<T> {
  filter: RealtimeFilter;
  resolve: (item: T | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A bounded per-tab ring. Waiters are woken by push, never by polling. */
export class Ring<T extends RealtimeItem> {
  readonly items: T[] = [];
  seq = 0;
  dropped = 0;
  private readonly waiters = new Set<Waiter<T>>();
  constructor(private readonly max = RING_MAX) {}

  push(item: Omit<T, "seq">): T {
    const full = { ...item, seq: ++this.seq } as T;
    this.items.push(full);
    if (this.items.length > this.max) {
      this.items.shift();
      this.dropped++;
    }
    for (const waiter of this.waiters)
      if (matchesFilter(full, waiter.filter)) this.settle(waiter, full);
    return full;
  }

  list(filter: RealtimeFilter, limit = RING_MAX): T[] {
    return this.items.filter((item) => matchesFilter(item, filter)).slice(-limit);
  }

  /** The first item after `since` (default: after now) that matches, or null at the timeout. */
  waitFor(filter: RealtimeFilter, timeoutMs: number): Promise<T | null> {
    const scoped = { ...filter, since: filter.since ?? this.seq };
    const ready = this.items.find((item) => matchesFilter(item, scoped));
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const waiter: Waiter<T> = {
        filter: scoped,
        resolve,
        timer: setTimeout(
          () => this.settle(waiter, null),
          Math.max(0, Math.min(timeoutMs, WAIT_MAX)),
        ),
      };
      this.waiters.add(waiter);
    });
  }

  get waiting(): number {
    return this.waiters.size;
  }

  close(): void {
    for (const waiter of this.waiters) this.settle(waiter, null);
  }

  private settle(waiter: Waiter<T>, item: T | null): void {
    clearTimeout(waiter.timer);
    this.waiters.delete(waiter);
    waiter.resolve(item);
  }
}

export function waitMs(options: Record<string, unknown>): number {
  const ms = Number(options.timeoutMs);
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, WAIT_MAX) : 30_000;
}

/** A page script that reports through a CDP binding, on this document and on later ones. */
export async function installTap(tabId: number, binding: string, source: string): Promise<string> {
  const label = "realtimeTap";
  await send({ tabId }, "Runtime.enable", {}, { label });
  await send({ tabId }, "Runtime.addBinding", { name: binding }, { label });
  const added = (await send(
    { tabId },
    "Page.addScriptToEvaluateOnNewDocument",
    { source },
    { label },
  )) as { identifier?: string } | undefined;
  await send({ tabId }, "Runtime.evaluate", { expression: source }, { label }).catch(
    () => undefined,
  );
  return String(added?.identifier ?? "");
}

export async function removeTap(tabId: number, binding: string, identifier: string) {
  const label = "realtimeTap";
  if (identifier)
    await send({ tabId }, "Page.removeScriptToEvaluateOnNewDocument", { identifier }, { label })
      .then(() => undefined)
      .catch(() => undefined);
  await send({ tabId }, "Runtime.removeBinding", { name: binding }, { label }).catch(
    () => undefined,
  );
}

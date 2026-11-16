// Politeness for the site and protection for the user's account: a per-site rate limit, a
// concurrency cap, and retries that back off on 429, 5xx, and the other rate-limit shapes
// (honouring Retry-After). Writes are never retried.

export class RateLimiter {
  private next = 0;
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly perSecond = 5,
    private readonly concurrency = 4,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency)
      await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      const wait = this.next - Date.now();
      this.next = Math.max(Date.now(), this.next) + 1000 / this.perSecond;
      if (wait > 0) await sleep(wait);
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function retryDelay(attempt: number, retryAfter?: string): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 60_000);
  }
  return Math.min(500 * 2 ** attempt + Math.random() * 250, 30_000);
}

export const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

const LIMIT_WORDS = /\b(rate[\s_-]?limits?|rate[\s_-]?limited|too many requests|throttled?)\b/i;
const ERROR_KEY =
  /^(errors?|messages?|msg|details?|descriptions?|codes?|statuses?|status(?:_?code)?|success|ok)$/i;
const DATA_KEY = /^(data|results?|items|records)$/i;

interface LimitResponse {
  status: number;
  headers?: Record<string, string>;
  text?: string;
  json?: unknown;
}

/** A read may be sent again. A write never is. 418 and 420 count only when they say so. */
export function shouldRetryRead(
  readOnly: boolean,
  response: LimitResponse,
  attempt: number,
  retries: number,
): boolean {
  if (!readOnly || attempt >= retries) return false;
  return RETRYABLE.has(response.status) || isRateLimited(response);
}

/** 429, a 418 or 420 that names a wait or a limit, or a short 2xx body that is only a 429. */
export function isRateLimited(response: LimitResponse): boolean {
  if (response.status === 429) return true;
  if (response.status === 418 || response.status === 420) return namedLimit(response);
  if (response.status < 200 || response.status >= 300) return false;
  const text = response.text ?? "";
  const value = response.json !== undefined ? response.json : parsedJson(text);
  return isJsonThrottle(value, text.length || 1);
}

/** An ability result whose whole body is an error naming 429. Data beside it is the site's answer. */
export function isJsonThrottle(value: unknown, size = JSON.stringify(value ?? "").length): boolean {
  if (size > 16_384) return false;
  const record = errorRecord(value);
  return record ? has429(record) : false;
}

function namedLimit(response: LimitResponse): boolean {
  const retryAfter = header(response.headers, "retry-after").trim();
  return retryAfter !== "" || LIMIT_WORDS.test((response.text ?? "").slice(0, 4096));
}

function header(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return "";
  const found = Object.keys(headers).find((key) => key.toLowerCase() === name);
  return found ? String(headers[found] ?? "") : "";
}

function parsedJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function errorRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.length || keys.some((key) => !ERROR_KEY.test(key) && !DATA_KEY.test(key)))
    return undefined;
  if (keys.some((key) => DATA_KEY.test(key) && record[key] !== undefined && record[key] !== null))
    return undefined;
  if (!keys.some((key) => /error|message|msg|detail|code|status/i.test(key))) return undefined;
  return record;
}

function has429(record: Record<string, unknown>): boolean {
  if (field429(record)) return true;
  return [record.error, record.errors].flat().some((item) => nested429(item));
}

function nested429(item: unknown): boolean {
  return !!item && typeof item === "object" && field429(item as Record<string, unknown>);
}

function field429(record: Record<string, unknown>): boolean {
  return Object.entries(record).some(
    ([key, value]) => /code|status/i.test(key) && (value === 429 || value === "429"),
  );
}

// Per-site token bucket for API calls and navigations. Burst, then about one call a second.
// A 429 or a challenge page halves the rate for ten minutes. Site notes of kind "pace" override it.

export interface PaceNote {
  kind: string;
  key: string;
  value: string;
}

export interface PaceClock {
  now(): number;
  wait(ms: number): Promise<void>;
}

interface Bucket {
  tokens: number;
  updated: number;
  perSecond: number;
  burst: number;
  penaltyUntil: number;
  /** This batch only. Cleared when the batch ends. Site notes stay on `perSecond`. */
  batchPerSecond?: number;
}

const PENALTY_MS = 10 * 60 * 1000;
const buckets = new Map<string, Bucket>();

let clock: PaceClock = {
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
let jitter = (): number => 0.8 + Math.random() * 0.4;

export function setPaceClock(next: PaceClock): void {
  clock = next;
}

export function setPaceJitter(next: () => number): void {
  jitter = next;
}

export function resetPace(): void {
  buckets.clear();
}

export function configurePace(site: string, policy: { perSecond?: number; burst?: number }): void {
  const bucket = ensure(site);
  if (policy.perSecond !== undefined) bucket.perSecond = policy.perSecond;
  if (policy.burst !== undefined) bucket.burst = policy.burst;
  bucket.tokens = Math.min(bucket.tokens, bucket.burst);
}

/** A batch's own rate. Omit the rate to clear it. Does not change the site note. */
export function setBatchRate(site: string, perSecond?: number): void {
  const bucket = ensure(site);
  if (perSecond !== undefined && perSecond > 0 && perSecond <= 20)
    bucket.batchPerSecond = perSecond;
  else delete bucket.batchPerSecond;
}

/** Structured site notes (`kind: "pace"`). "1 per second", "1/s", "burst 2". */
export function applyPaceNotes(site: string, notes: readonly PaceNote[]): void {
  for (const note of notes) {
    if (note.kind !== "pace") continue;
    const text = `${note.key} ${note.value}`;
    configurePace(site, { ...rateOf(text), ...burstOf(text) });
  }
}

export function paceExpectedMs(site: string, calls: number): number {
  const bucket = ensure(site);
  const paced = Math.max(0, calls - bucket.burst);
  return Math.round((paced / effectiveRate(bucket, clock.now())) * 1000);
}

export function formatPace(site: string, calls: number): string {
  const seconds = (paceExpectedMs(site, calls) / 1000).toFixed(1);
  return `[pace] ${calls} calls on ${site}, about ${seconds}s`;
}

export async function takePace(site: string): Promise<void> {
  const bucket = ensure(site);
  refill(bucket);
  const rate = effectiveRate(bucket, clock.now());
  // Reserve before waiting so two overlapping callers cannot both pass on one token.
  const deficit = Math.max(0, 1 - bucket.tokens);
  bucket.tokens -= 1;
  if (deficit <= 0) return;
  const gap = Math.round((deficit / rate) * 1000 * jitter());
  await clock.wait(gap);
}

export function notePaceLimit(site: string): void {
  const bucket = ensure(site);
  bucket.penaltyUntil = clock.now() + PENALTY_MS;
  bucket.tokens = Math.min(bucket.tokens, 1);
}

export function paceLimited(site: string): boolean {
  return clock.now() < ensure(site).penaltyUntil;
}

/** Runs `call` once per row, paced, and retries once after a 429. Prints nothing; returns the note. */
export async function exportPaced<T>(
  site: string,
  rows: readonly unknown[],
  call: (row: unknown, index: number) => Promise<T>,
): Promise<{ rows: T[]; note: string; expectedMs: number }> {
  const note = formatPace(site, rows.length);
  const out: T[] = [];
  for (let index = 0; index < rows.length; index += 1)
    out.push(await oneRow(site, rows[index], index, call));
  return { rows: out, note, expectedMs: paceExpectedMs(site, rows.length) };
}

async function oneRow<T>(
  site: string,
  row: unknown,
  index: number,
  call: (row: unknown, index: number) => Promise<T>,
): Promise<T> {
  await takePace(site);
  try {
    return await call(row, index);
  } catch (error) {
    if (!is429(error)) throw error;
    notePaceLimit(site);
    await takePace(site);
    return call(row, index);
  }
}

function is429(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status;
  const message = error instanceof Error ? error.message : String(error);
  return status === 429 || /\b429\b/.test(message);
}

function ensure(site: string): Bucket {
  const existing = buckets.get(site);
  if (existing) return existing;
  const created: Bucket = {
    tokens: 5,
    updated: clock.now(),
    perSecond: 1,
    burst: 5,
    penaltyUntil: 0,
  };
  buckets.set(site, created);
  return created;
}

function refill(bucket: Bucket): void {
  const now = clock.now();
  const elapsed = Math.max(0, now - bucket.updated) / 1000;
  bucket.tokens = Math.min(bucket.burst, bucket.tokens + elapsed * effectiveRate(bucket, now));
  bucket.updated = now;
}

function effectiveRate(bucket: Bucket, now: number): number {
  const rate = bucket.batchPerSecond ?? bucket.perSecond;
  return now < bucket.penaltyUntil ? rate / 2 : rate;
}

function rateOf(text: string): { perSecond?: number } {
  const match = /(\d+(?:\.\d+)?)\s*(?:\/\s*s|per\s+second)/i.exec(text);
  const rate = match ? Number(match[1]) : Number.NaN;
  return rate > 0 && rate <= 20 ? { perSecond: rate } : {};
}

function burstOf(text: string): { burst?: number } {
  const match = /burst\s+(\d+)/i.exec(text);
  const burst = match ? Number(match[1]) : Number.NaN;
  return burst >= 1 && burst <= 20 ? { burst } : {};
}

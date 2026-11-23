// Server-clock sync, a millisecond scheduler and a bounded parallel pool. Plain functions with no
// imports, so the code sandbox runs the very same source (code-api-timing.ts embeds it as text) and
// the tests here check what agents run. Nothing in it calls a model: a sniper fires on its own.

export interface ClockSample {
  /** Local ms when the request was sent and when its answer arrived. */
  sentAt: number;
  receivedAt: number;
  /** The server's Date header, as epoch ms. */
  serverDate: number;
}

export interface ClockSync {
  serverOffsetMs: number;
  rttMs: number;
  samples: number;
}

export interface ScheduleOptions {
  offsetMs?: number;
  leadMs?: number;
  spinMs?: number;
  signal?: AbortSignal;
  now?: () => number;
}

export interface PoolOptions {
  concurrency?: number;
  jitterMs?: number;
  pauseOnRateLimit?: boolean;
  retries?: number;
  maxPauseMs?: number;
  signal?: AbortSignal;
  random?: () => number;
}

export interface PoolLane {
  signal: AbortSignal;
  lane: number;
  /** Registers cleanup for this lane (a tab to close); it runs when the pool ends, on any outcome. */
  onCleanup(fn: () => unknown): void;
}

export type PoolOutcome<R> = { ok: true; value: R } | { ok: false; error: string };

export function createTimingKit() {
  function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  }

  /** The server clock minus ours: each sample's server time against the midpoint of its trip. */
  function serverOffset(samples: ClockSample[], precisionMs = 1000): ClockSync {
    const good = samples.filter((s) => Number.isFinite(s.serverDate) && s.receivedAt >= s.sentAt);
    if (!good.length) throw new Error("CLOCK_SYNC: no probe returned a usable Date header");
    // A Date header is floored to its precision, so its true time is on average half a step later.
    const half = precisionMs / 2;
    const offsets = good.map(
      (s) => s.serverDate + half - (s.sentAt + (s.receivedAt - s.sentAt) / 2),
    );
    return {
      serverOffsetMs: Math.round(median(offsets)),
      rttMs: Math.round(median(good.map((s) => s.receivedAt - s.sentAt))),
      samples: good.length,
    };
  }

  /** Probes the server a few times (sequentially, so trips do not queue) and returns its offset. */
  async function syncClock(
    probe: () => Promise<number>,
    options: { probes?: number; precisionMs?: number; now?: () => number } = {},
  ): Promise<ClockSync> {
    const now = options.now ?? Date.now;
    const count = Math.min(Math.max(Number(options.probes ?? 5), 1), 15);
    const samples: ClockSample[] = [];
    for (let index = 0; index < count; index++) {
      const sentAt = now();
      const serverDate = await probe().catch(() => Number.NaN);
      samples.push({ sentAt, receivedAt: now(), serverDate });
    }
    return serverOffset(samples, options.precisionMs);
  }

  function abortError(): Error {
    return Object.assign(new Error("ABORTED: the scheduled moment was cancelled"), {
      name: "AbortError",
    });
  }

  function nap(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const stop = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      const timer = setTimeout(
        () => {
          signal?.removeEventListener("abort", stop);
          resolve();
        },
        Math.max(0, ms),
      );
      signal?.addEventListener("abort", stop, { once: true });
    });
  }

  /**
   * Runs fn when the server clock reads targetMs: a coarse timer to spinMs before, then a tight
   * loop on the clock for the final milliseconds. leadMs fires early (half the trip, so the request
   * lands on time). Resolves with fn's result and how late (in local ms) it fired.
   */
  async function scheduleAt<R>(
    targetMs: number,
    fn: () => R | Promise<R>,
    options: ScheduleOptions = {},
  ) {
    const now = options.now ?? Date.now;
    const fireAt = targetMs - (options.offsetMs ?? 0) - (options.leadMs ?? 0);
    const spin = Math.max(0, options.spinMs ?? 12);
    if (fireAt - now() > spin) await nap(fireAt - now() - spin, options.signal);
    while (now() < fireAt) {
      if (options.signal?.aborted) throw abortError();
      // Yield while there is room so an abort or another timer can still run; the last few
      // milliseconds are a pure spin on the clock, since a timer can overshoot by that much.
      if (fireAt - now() > 6) await nap(0, options.signal);
    }
    if (options.signal?.aborted) throw abortError();
    const firedAt = now();
    const result = await fn();
    return { result, firedAt, lateMs: firedAt - fireAt };
  }

  /** How long a rate-limited answer asks us to wait: Retry-After seconds or date, else undefined. */
  function retryAfterMs(value: unknown, nowMs: number): number | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(String(value));
    return Number.isFinite(date) ? Math.max(0, date - nowMs) : undefined;
  }

  /** A 429 (or 503 with Retry-After) from a thrown error or a returned response-like value. */
  function rateLimit(value: unknown, nowMs: number): { waitMs?: number | undefined } | undefined {
    const v = value as { status?: number; headers?: Record<string, string>; retryAfter?: unknown };
    if (!v || typeof v !== "object") return undefined;
    const header = v.retryAfter ?? v.headers?.["retry-after"] ?? v.headers?.["Retry-After"];
    if (v.status === 429 || (v.status === 503 && header !== undefined))
      return { waitMs: retryAfterMs(header, nowMs) };
    return undefined;
  }

  /**
   * worker(item, index, lane) over items with at most `concurrency` running. A rate limit pauses
   * every lane until Retry-After (or a doubling backoff) and retries that item. Results keep the
   * input order as {ok, value} or {ok, error}. Abort stops new work; lane cleanups always run.
   */
  async function poolMap<T, R>(
    items: T[],
    worker: (item: T, index: number, lane: PoolLane) => Promise<R>,
    options: PoolOptions = {},
  ): Promise<{ results: PoolOutcome<R>[]; pauses: number; cancelled: boolean }> {
    const concurrency = Math.min(Math.max(Math.floor(Number(options.concurrency ?? 4)), 1), 16);
    const retries = Math.max(Number(options.retries ?? 3), 0);
    const jitter = Math.max(Number(options.jitterMs ?? 0), 0);
    const random = options.random ?? Math.random;
    const pauseOnRateLimit = options.pauseOnRateLimit !== false;
    const maxPause = Math.max(Number(options.maxPauseMs ?? 60000), 0);
    const control = new AbortController();
    const forward = () => control.abort();
    options.signal?.addEventListener("abort", forward, { once: true });
    if (options.signal?.aborted) control.abort();
    const results: PoolOutcome<R>[] = new Array(items.length);
    const cleanups: (() => unknown)[] = [];
    let next = 0;
    let pausedUntil = 0;
    let pauses = 0;

    async function waitTurn() {
      if (jitter) await nap(random() * jitter, control.signal);
      while (pausedUntil > Date.now()) await nap(pausedUntil - Date.now(), control.signal);
    }

    async function once(index: number, lane: PoolLane, attempt: number): Promise<PoolOutcome<R>> {
      await waitTurn();
      let limited: { waitMs?: number | undefined } | undefined;
      try {
        const value = await worker(items[index]!, index, lane);
        limited = pauseOnRateLimit ? rateLimit(value, Date.now()) : undefined;
        if (!limited) return { ok: true, value };
      } catch (error) {
        if (control.signal.aborted) throw error;
        limited = pauseOnRateLimit ? rateLimit(error, Date.now()) : undefined;
        if (!limited) return { ok: false, error: String((error as Error)?.message ?? error) };
      }
      if (attempt >= retries)
        return { ok: false, error: "RATE_LIMITED: still limited after retries" };
      const wait = Math.min(limited.waitMs ?? 1000 * 2 ** attempt, maxPause);
      pausedUntil = Math.max(pausedUntil, Date.now() + wait);
      pauses += 1;
      return once(index, lane, attempt + 1);
    }

    async function run(laneNumber: number) {
      const lane: PoolLane = {
        signal: control.signal,
        lane: laneNumber,
        onCleanup: (fn) => void cleanups.push(fn),
      };
      while (!control.signal.aborted && next < items.length) {
        const index = next++;
        results[index] = await once(index, lane, 0);
      }
    }

    try {
      const lanes = Array.from({ length: Math.min(concurrency, items.length) }, (_, n) => run(n));
      await Promise.allSettled(lanes);
    } finally {
      options.signal?.removeEventListener("abort", forward);
      await Promise.allSettled(cleanups.map(async (fn) => fn()));
    }
    for (let index = 0; index < items.length; index++)
      results[index] ??= { ok: false, error: "CANCELLED" };
    return { results, pauses, cancelled: control.signal.aborted };
  }

  return { median, serverOffset, syncClock, scheduleAt, poolMap, retryAfterMs, rateLimit };
}

// Invariant I-4: a human volume budget per (site, account). At most 2 lanes at once on a vendor
// site, 1 write a second and 60 reads a minute. Work over the budget waits its turn in FIFO order;
// it never fails for hitting the budget. Observed human rates can raise a cap, at most 3x.

export type BudgetKind = "read" | "write" | "lane";

export interface BudgetClock {
  now(): number;
  /** Resolves after `ms`, or rejects when the signal aborts. */
  wait(ms: number, signal?: AbortSignal): Promise<void>;
}

export const DEFAULT_CAPS = { lanes: 2, writesPerSecond: 1, readsPerMinute: 60 } as const;
export const MAX_BOOST = 3;

export interface BudgetCaps {
  lanes: number;
  writesPerSecond: number;
  readsPerMinute: number;
}

export interface AcquireOptions {
  kind: BudgetKind;
  signal?: AbortSignal;
  /** Gives up waiting after this many ms (rejects with a TimeoutError). */
  timeoutMs?: number;
}

const realClock: BudgetClock = {
  now: () => Date.now(),
  wait: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError(signal));
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => (clearTimeout(timer), reject(abortError(signal))), {
        once: true,
      });
    }),
};

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("aborted", "AbortError");
}

interface Waiter {
  kind: BudgetKind;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
}

/** One (site, account) budget. */
class Lane {
  caps: BudgetCaps = { ...DEFAULT_CAPS };
  readonly stamps: Record<"read" | "write", number[]> = { read: [], write: [] };
  active = 0;
  /** One FIFO queue per kind, so a write waiting its second never holds up a read. */
  readonly queues: Record<BudgetKind, Waiter[]> = { read: [], write: [], lane: [] };
  readonly pumping = new Set<BudgetKind>();
}

export class HumanBudget {
  private readonly lanes = new Map<string, Lane>();
  constructor(private readonly clock: BudgetClock = realClock) {}

  private lane(site: string, account: string): Lane {
    const key = `${site}\u0000${account}`;
    let lane = this.lanes.get(key);
    if (!lane) this.lanes.set(key, (lane = new Lane()));
    return lane;
  }

  /** The caps in force for this (site, account). */
  caps(site: string, account = "default"): BudgetCaps {
    return { ...this.lane(site, account).caps };
  }

  /** Raises a cap to an observed human rate, clamped between the default and 3x the default. */
  observeHumanRate(site: string, observed: Partial<BudgetCaps>, account = "default"): BudgetCaps {
    const caps = this.lane(site, account).caps;
    for (const name of Object.keys(DEFAULT_CAPS) as (keyof BudgetCaps)[]) {
      const value = observed[name];
      if (value === undefined || !Number.isFinite(value)) continue;
      const base = DEFAULT_CAPS[name];
      caps[name] = Math.min(base * MAX_BOOST, Math.max(caps[name], value));
    }
    return { ...caps };
  }

  /** Waits for room, then returns the release function. Only a lane holds room until released. */
  acquire(site: string, options: AcquireOptions, account = "default"): Promise<() => void> {
    const lane = this.lane(site, account);
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { kind: options.kind, resolve, reject };
      const drop = (error: unknown) => {
        const queue = lane.queues[waiter.kind];
        const at = queue.indexOf(waiter);
        if (at < 0) return;
        queue.splice(at, 1);
        reject(error);
      };
      signal?.addEventListener("abort", () => drop(abortError(signal)), { once: true });
      if (options.timeoutMs !== undefined)
        void this.clock
          .wait(options.timeoutMs, signal)
          .then(() => drop(new DOMException("budget wait timed out", "TimeoutError")))
          .catch(() => undefined);
      lane.queues[waiter.kind].push(waiter);
      void this.pump(lane, waiter.kind);
    });
  }

  /** Runs `work` inside the budget. */
  async run<T>(
    site: string,
    options: AcquireOptions,
    work: () => Promise<T>,
    account = "default",
  ): Promise<T> {
    const release = await this.acquire(site, options, account);
    try {
      return await work();
    } finally {
      release();
    }
  }

  /** Milliseconds until the head waiter fits, 0 when it fits now, -1 for a full lane set. */
  private delay(lane: Lane, kind: BudgetKind): number {
    if (kind === "lane") return lane.active < lane.caps.lanes ? 0 : -1;
    const now = this.clock.now();
    const windowMs = kind === "write" ? 1000 : 60_000;
    const cap = kind === "write" ? lane.caps.writesPerSecond : lane.caps.readsPerMinute;
    const stamps = lane.stamps[kind];
    while ((stamps[0] ?? Infinity) <= now - windowMs) stamps.shift();
    if (stamps.length < cap) return 0;
    return (stamps[stamps.length - cap] ?? now) + windowMs - now;
  }

  private grant(lane: Lane, waiter: Waiter): void {
    lane.queues[waiter.kind].shift();
    if (waiter.kind === "lane") {
      lane.active++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        lane.active--;
        void this.pump(lane, "lane");
      });
      return;
    }
    lane.stamps[waiter.kind].push(this.clock.now());
    waiter.resolve(() => undefined);
  }

  /** Grants the queue head in order. A head that has to wait holds everyone behind it (FIFO). */
  private async pump(lane: Lane, kind: BudgetKind): Promise<void> {
    if (lane.pumping.has(kind)) return;
    lane.pumping.add(kind);
    const queue = lane.queues[kind];
    try {
      for (let head = queue[0]; head; head = queue[0]) {
        const wait = this.delay(lane, kind);
        if (wait === 0) this.grant(lane, head);
        else if (wait < 0) return;
        else await this.clock.wait(wait);
      }
    } finally {
      lane.pumping.delete(kind);
    }
  }
}

/** The process-wide budget the site runtime uses. */
export const humanBudget = new HumanBudget();

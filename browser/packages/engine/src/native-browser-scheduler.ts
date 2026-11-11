// Locks are scoped to what is shared. A tab's input and evaluation take `tab:<id>`. Activation,
// split view and anything the user sees take `window:<id>`. The file chooser, the downloads
// shelf, and paste (one clipboard document for the whole browser) take `browser`. CDP input is
// per target and needs no OS focus. Every wait is bounded. A waiter that gives up does not run.

import type { BrowserStep } from "@browserkit/protocol";
import { browserStepWrites } from "@browserkit/protocol";

interface TabQueue {
  tail: Promise<unknown>;
  depth: number;
}

interface Gate {
  tail: Promise<void>;
  held: boolean;
  waiting: number;
}

const queues = new Map<number, TabQueue>();
const gates = new Map<string, Gate>();
let writeWaitMs = 30_000;

/** Tests shorten the 30s busy wait. Production leaves it alone. */
export function setLockWaitMs(ms: number): void {
  writeWaitMs = ms;
}

export function isWriteStep(step: BrowserStep): boolean {
  return browserStepWrites(step);
}

/** The lock a step needs, or undefined when it only reads. */
export function lockScope(step: BrowserStep, tabId: number, windowId?: number): string | undefined {
  void windowId;
  if (step.op === "upload") return "browser";
  if (step.op === "downloads" && isWriteStep(step)) return "browser";
  if (step.op === "paste") return "browser";
  if (step.op === "evaluate" || isWriteStep(step)) return `tab:${tabId}`;
  return undefined;
}

export async function inTabQueue<T>(tabId: number, work: () => Promise<T>): Promise<T> {
  const queue = queues.get(tabId) ?? { tail: Promise.resolve(), depth: 0 };
  queues.set(tabId, queue);
  queue.depth += 1;
  const run = queue.tail.then(work, work);
  queue.tail = run.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await run;
  } finally {
    queue.depth -= 1;
    if (queue.depth === 0 && queues.get(tabId) === queue) queues.delete(tabId);
  }
}

export async function withLock<T>(scope: string, work: () => Promise<T>): Promise<T> {
  const gate = gates.get(scope) ?? { tail: Promise.resolve(), held: false, waiting: 0 };
  gates.set(scope, gate);
  const previous = gate.tail;
  let release: () => void = () => undefined;
  gate.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  gate.waiting += 1;
  let acquired = false;
  try {
    await withDeadline(previous, writeWaitMs, `BUSY_TIMEOUT: ${scope} was busy for 30s`);
    acquired = true;
    gate.held = true;
    return await work();
  } finally {
    gate.waiting -= 1;
    if (acquired) {
      gate.held = false;
      release();
    } else {
      // Timed out before taking the lock. The holder still owns it: fail, and let the
      // next waiter through only once the holder finishes.
      void previous.then(release, release);
    }
  }
}

export interface SchedulerStatus {
  write: { busy: boolean; waiting: number };
  tabs: { tabId: number; busy: boolean; waiting: number }[];
  scopes: { scope: string; busy: boolean; waiting: number }[];
}

export function schedulerStatus(): SchedulerStatus {
  const browser = gates.get("browser");
  return {
    write: { busy: browser?.held === true, waiting: browser?.waiting ?? 0 },
    tabs: [...queues].map(([tabId, queue]) => ({
      tabId,
      busy: queue.depth > 0,
      waiting: Math.max(0, queue.depth - 1),
    })),
    scopes: [...gates].map(([scope, gate]) => ({
      scope,
      busy: gate.held,
      waiting: gate.waiting,
    })),
  };
}

/**
 * One dispatch under the per-tab FIFO and the lock for what the step shares.
 * Reads skip both: they never change a page, so several can run at once.
 */
export async function scheduleStep<T>(
  step: BrowserStep,
  tabId: number,
  dispatch: () => Promise<T>,
  windowId?: number,
): Promise<T> {
  const scope = lockScope(step, tabId, windowId);
  if (!scope) return dispatch();
  const queued = Date.now();
  return inTabQueue(tabId, () =>
    withLock(scope, () => {
      const waited = Date.now() - queued;
      if (waited >= WAIT_NOTE_MS) writeWaits.set(tabId, waited);
      return dispatch();
    }),
  );
}

/** How long the last write in a tab waited for a shared lock, when it was long. */
const writeWaits = new Map<number, number>();
const WAIT_NOTE_MS = 1000;
export function takeWriteWait(tabId: number): number | undefined {
  const waited = writeWaits.get(tabId);
  writeWaits.delete(tabId);
  return waited;
}

async function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

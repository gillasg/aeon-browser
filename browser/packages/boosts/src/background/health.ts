import { nextHealth } from "../shared/health.js";
import type { Health, HealthReport } from "../shared/types.js";
import { getHealth, log, setHealth } from "./store.js";

// Records what each boost did on each visit, and asks for a repair when one breaks. The script
// runtime reports when it started and what it threw, so the agent sees both in boosts.list/get.

type BrokenListener = (boostId: string, tabId: number | undefined) => void;
const listeners: BrokenListener[] = [];

export function onBroken(listener: BrokenListener): void {
  listeners.push(listener);
}

let chain: Promise<unknown> = Promise.resolve();

/** Health writes run one at a time, so reports from the page and the script do not race. */
function queued(run: () => Promise<void>): Promise<void> {
  const next = chain.then(run);
  chain = next.catch(() => undefined);
  return next;
}

export function recordHealth(boostId: string, report: HealthReport, tabId?: number): Promise<void> {
  return queued(async () => {
    const previous = await getHealth(boostId);
    const next = nextHealth(previous, report);
    await setHealth(boostId, next);
    if (next.status === "broken" && previous.status !== "broken") {
      log({
        level: "warn",
        boostId,
        url: report.url,
        message: `Stopped working${next.broken?.length ? `: ${next.broken.join(", ")} no longer match` : ""}`,
      });
      for (const listener of listeners) listener(boostId, tabId);
    }
  });
}

/** The script started on a page. */
export function recordRun(boostId: string, url: string): Promise<void> {
  return queued(async () => {
    const health = await getHealth(boostId);
    await setHealth(boostId, { ...health, lastRun: { at: Date.now(), url } });
  });
}

/** The script threw (or rejected) without catching it. */
export function recordError(
  boostId: string,
  error: { message: string; stack?: string | undefined },
  url: string,
): Promise<void> {
  return queued(async () => {
    const health = await getHealth(boostId);
    const lastError: NonNullable<Health["lastError"]> = {
      message: error.message.slice(0, 2000),
      at: Date.now(),
      url,
      ...(error.stack ? { stack: error.stack.slice(0, 4000) } : {}),
    };
    await setHealth(boostId, { ...health, lastError });
  });
}

import type { RoutineRecord } from "@graft/domain";
import { isLive } from "./routine-listen.js";

// Listening routines: a check that starts with "use listen", or a routine with a live `listen`
// filter. They run back to back instead of once per slot. Each run waits inside the browser for
// something to happen (page.waitForResponse and the routine's check) and returns as soon as it
// does, so the routine wakes within seconds instead of on the next minute. Scheduled slots of a
// listening routine are skipped, unless it is a live routine with no matching tab open: then it
// stays idle and the normal timer check runs (the fallback).

export const LISTEN_DIRECTIVE = /^\s*["']use listen["'];?/;
export const LISTEN_TIMEOUT_MS = 58_000;
const POLL_MS = 3_000;
const ERROR_BACKOFF_MS = 30_000;

export const isListening = (routine: Pick<RoutineRecord, "check">): boolean =>
  Boolean(routine.check && LISTEN_DIRECTIVE.test(routine.check));

type CheckResult = { met: boolean; value?: unknown; error?: string; idle?: boolean };

/**
 * One listener pass. A live routine waits on an open tab; when none matches it is idle, and a
 * check that also says "use listen" then runs on its own (it opens its page and waits there).
 * The timer skips every "use listen" routine, so without this a live listening check whose tab
 * was closed never ran again and its watcher never fired.
 */
export async function listenerPass(
  routine: Pick<RoutineRecord, "check" | "listen">,
  live: () => Promise<CheckResult>,
  plain: () => Promise<CheckResult>,
): Promise<CheckResult> {
  if (!isLive(routine)) return plain();
  const heard = await live();
  return heard.idle && isListening(routine) ? plain() : heard;
}

export interface ListenerHost {
  routines(): readonly RoutineRecord[];
  available(routine: RoutineRecord): boolean;
  check(
    routine: RoutineRecord,
  ): Promise<{ met: boolean; value?: unknown; error?: string; idle?: boolean }>;
  heard(routine: RoutineRecord, value: unknown): void;
  /** A listening check that threw: shown on the routine, so it never fails silently. */
  failed?(routine: RoutineRecord, error: string): void;
}

export class RoutineListeners {
  private readonly running = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private started = false;

  constructor(private readonly host: ListenerHost) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.refresh();
  }

  close(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private refresh(): void {
    if (!this.started) return;
    for (const routine of this.host.routines())
      if (this.wanted(routine) && !this.running.has(routine.routineId))
        this.running.set(
          routine.routineId,
          this.loop(routine.routineId).finally(() => this.running.delete(routine.routineId)),
        );
    this.timer = setTimeout(() => this.refresh(), POLL_MS);
    this.timer.unref();
  }

  private wanted(routine: RoutineRecord): boolean {
    return routine.enabled && !routine.deletedAt && (isListening(routine) || isLive(routine));
  }

  private current(routineId: string): RoutineRecord | undefined {
    return this.host.routines().find((routine) => routine.routineId === routineId);
  }

  private async loop(routineId: string): Promise<void> {
    for (;;) {
      const routine = this.current(routineId);
      if (!this.started || !routine || !this.wanted(routine)) return;
      if (!this.host.available(routine)) {
        await pause(POLL_MS * 3);
        continue;
      }
      const result = await this.host.check(routine).catch((error: unknown) => ({
        met: false,
        idle: false,
        error: error instanceof Error ? error.message : String(error),
      }));
      if (result.met) this.host.heard(routine, (result as { value?: unknown }).value);
      else if (result.error) {
        this.host.failed?.(routine, result.error);
        await pause(ERROR_BACKOFF_MS);
      } else if (result.idle)
        await pause(POLL_MS); // no matching tab / response yet: let the timer run
      else await pause(250);
    }
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

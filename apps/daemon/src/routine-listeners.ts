import type { RoutineRecord } from "@aeon/domain";

// Listening routines: a check that starts with "use listen"; runs back to back instead of once per
// slot. Each run waits inside the browser for something to happen (page.waitForChange,
// page.waitForResponse, page.waitForMessage) and returns as soon as it does, so the routine wakes
// within seconds instead of on the next minute. Scheduled slots of a listening routine are skipped.

export const LISTEN_DIRECTIVE = /^\s*["']use listen["'];?/;
export const LISTEN_TIMEOUT_MS = 58_000;
const POLL_MS = 3_000;
const ERROR_BACKOFF_MS = 30_000;

export const isListening = (routine: Pick<RoutineRecord, "check">): boolean =>
  Boolean(routine.check && LISTEN_DIRECTIVE.test(routine.check));

export interface ListenerHost {
  routines(): readonly RoutineRecord[];
  available(routine: RoutineRecord): boolean;
  check(routine: RoutineRecord): Promise<{ met: boolean; value?: unknown; error?: string }>;
  heard(routine: RoutineRecord, value: unknown): void;
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
    return routine.enabled && !routine.deletedAt && isListening(routine);
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
        error: error instanceof Error ? error.message : String(error),
      }));
      if (result.met) this.host.heard(routine, (result as { value?: unknown }).value);
      else if (result.error) await pause(ERROR_BACKOFF_MS);
      else await pause(250);
    }
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

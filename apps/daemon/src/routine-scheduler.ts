import { createHash, randomUUID } from "node:crypto";
import type {
  PiRoutineRunEvidence,
  PiSessionHandle,
  AeonProductStore,
  RoutineRecord,
  RoutineRunRecord,
  RoutineRunState,
} from "@aeon/domain";
import type { ChatService } from "./chat-service.js";
import type { BrowserControlService } from "./browser-control-service.js";
import { collectDueSlots } from "./routine-schedule.js";
import { siteApiRequest } from "@aeon/pi-adapter";
import { isListening, LISTEN_TIMEOUT_MS, RoutineListeners } from "./routine-listeners.js";

const TICK_MS = 10_000;
const MAX_RUNS_PER_TICK = 32;
const CHECK_TIMEOUT_MS = 30_000;

export class RoutineScheduler {
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private ticking = false;
  private readonly subscriptions = new Map<string, () => void>();
  /** What a listening routine heard, waiting for the run it triggered. */
  private readonly heard = new Map<string, unknown>();
  private readonly listeners = new RoutineListeners({
    routines: () => this.store.listRoutines(),
    available: (routine) =>
      !routine.requiredBrowserInstanceId ||
      this.browser.isInstanceAvailable(routine.requiredBrowserInstanceId),
    check: (routine) => this.runCheck(routine, `listen:${randomUUID()}`, LISTEN_TIMEOUT_MS),
    heard: (routine, value) => {
      this.heard.set(routine.routineId, value);
      this.runNow(routine.routineId);
    },
  });

  constructor(
    private readonly store: AeonProductStore,
    private readonly chats: ChatService,
    private readonly browser: BrowserControlService,
  ) {}

  /** Told when a watcher's check passes, before its agent run (a notification, at once). */
  onAlert: ((chatId: string, title: string, message: string) => void) | undefined;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.reconcileOpenRuns();
    this.listeners.start();
    await this.tick();
  }

  wake(): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    void this.tick();
  }

  close(): void {
    this.started = false;
    this.listeners.close();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
  }

  runNow(routineId: string): RoutineRunRecord {
    const now = new Date().toISOString();
    const run = this.store.createManualRoutineRun({
      runId: randomUUID(),
      routineId,
      scheduledSlot: `manual:${randomUUID()}`,
      now,
    });
    this.wake();
    return run;
  }

  private async tick(): Promise<void> {
    if (this.ticking || !this.started) return;
    this.ticking = true;
    try {
      await this.claimDueSlots();
      await this.dispatchDueRuns();
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown scheduler error";
      process.stderr.write(`Aeon routine scheduler: ${message.slice(0, 400)}\n`);
    } finally {
      this.ticking = false;
      if (this.started) {
        this.timer = setTimeout(() => void this.tick(), TICK_MS);
        this.timer.unref();
      }
    }
  }

  private async claimDueSlots(): Promise<void> {
    const now = new Date().toISOString();
    for (const routine of this.store.listDueRoutines(now)) {
      if (!routine.nextDueAt) continue;
      const collected = collectDueSlots(routine.schedule, routine.nextDueAt, now);
      const slots = collected.slots.map((scheduledSlot) => ({
        runId: randomUUID(),
        scheduledSlot,
      }));
      this.store.claimDueRoutineSlots({
        routineId: routine.routineId,
        expectedRevision: routine.revision,
        expectedNextDueAt: routine.nextDueAt,
        nextDueAt: collected.nextDueAt,
        now,
        slots,
      });
    }
  }

  private async dispatchDueRuns(): Promise<void> {
    for (const run of this.store.listDueRoutineRuns(MAX_RUNS_PER_TICK)) {
      await this.dispatch(run);
    }
  }

  private async dispatch(run: RoutineRunRecord): Promise<void> {
    const routine = this.store.getRoutine(run.routineId);
    const chat = this.chats.getChat(run.chatId);
    if (
      !routine ||
      !routine.enabled ||
      routine.deletedAt ||
      !chat ||
      chat.status === "unavailable" ||
      chat.status === "failed"
    ) {
      this.update(run.runId, "unavailable", { lastError: "ROUTINE_TARGET_UNAVAILABLE" });
      return;
    }
    if (
      routine.requiredBrowserInstanceId &&
      !this.browser.isInstanceAvailable(routine.requiredBrowserInstanceId)
    ) {
      this.update(run.runId, "unavailable", {
        lastError: "REQUIRED_BROWSER_INSTANCE_UNAVAILABLE",
      });
      return;
    }
    const instruction = await this.instructionFor(routine, run);
    if (instruction === undefined) return;
    this.update(run.runId, "pending");
    try {
      await this.chats.withSession(run.chatId, async (session) => {
        this.watch(run.runId, session);
        const evidence = session.findRoutineRun(run.runId);
        if (evidence.state !== "not-found") {
          this.applyEvidence(run.runId, evidence);
          return;
        }
        try {
          const accepted = await session.invokeRoutine({
            runId: run.runId,
            routineId: routine.routineId,
            title: routine.title,
            scheduledSlot: run.scheduledSlot,
            instruction,
          });
          this.update(run.runId, "accepted", { piEntryId: accepted.piEntryId });
        } catch {
          const afterFailure = session.findRoutineRun(run.runId);
          if (afterFailure.state !== "not-found") this.applyEvidence(run.runId, afterFailure);
          else this.update(run.runId, "uncertain", { lastError: "ROUTINE_ACCEPTANCE_UNCERTAIN" });
        }
      });
    } catch {
      this.update(run.runId, "uncertain", { lastError: "ROUTINE_ACCEPTANCE_UNCERTAIN" });
    }
  }

  /** The instruction to send, or undefined when a watcher's check did not pass (run recorded). */
  private async instructionFor(
    routine: RoutineRecord,
    run: RoutineRunRecord,
  ): Promise<string | undefined> {
    if (!routine.check) return routine.instruction;
    const check = isListening(routine)
      ? this.takeHeard(routine.routineId)
      : await this.runCheck(routine, run.runId);
    if (check.met) {
      this.onAlert?.(routine.chatId, routine.title, describeCheck(check.value));
      return `${routine.instruction}

This routine's check passed with: ${JSON.stringify(check.value).slice(0, 4000)}`;
    }
    const completedAt = new Date().toISOString();
    if (check.error) this.update(run.runId, "failed", { completedAt, lastError: check.error });
    else this.update(run.runId, "skipped", { completedAt });
    return undefined;
  }

  /**
   * Runs a watcher's check as plain browser code: no model call. It gets its own realm (one per
   * routine), so a check can keep values between slots without touching the chat's own realm.
   */
  /** A listening routine's runs carry what it heard; its scheduled slots are skipped. */
  private takeHeard(routineId: string): { met: boolean; value?: unknown; error?: string } {
    if (!this.heard.has(routineId)) return { met: false };
    const value = this.heard.get(routineId);
    this.heard.delete(routineId);
    return { met: true, value };
  }

  private async runCheck(
    routine: RoutineRecord,
    id: string,
    timeoutMs = CHECK_TIMEOUT_MS,
  ): Promise<{ met: boolean; value?: unknown; error?: string }> {
    const raw = await this.browser.execute(checkRealm(routine.routineId), `routine-check:${id}`, {
      codeCell: {
        code: routine.check ?? "",
        timeoutMs,
        // Checks can call and watch mapped site APIs; workspace files stay with the chat.
        onCall: (request: unknown) =>
          siteApiRequest(checkRealm(routine.routineId), request) ??
          Promise.reject(new Error("Workspace calls are unavailable in routine checks")),
        onProgress: () => undefined,
      },
    });
    try {
      const result = JSON.parse(raw) as { value?: unknown; error?: string };
      if (result.error) return { met: false, error: `CHECK_FAILED: ${result.error}`.slice(0, 500) };
      return { met: Boolean(result.value), value: result.value };
    } catch {
      return { met: false, error: "CHECK_FAILED: unreadable result" };
    }
  }

  private async reconcileOpenRuns(): Promise<void> {
    for (const run of this.store.listOpenRoutineRuns()) {
      if (run.state === "due") continue;
      try {
        await this.chats.withSession(run.chatId, async (session) => {
          this.watch(run.runId, session);
          const evidence = session.findRoutineRun(run.runId);
          if (evidence.state === "not-found")
            this.update(run.runId, "uncertain", { lastError: "ROUTINE_RECOVERY_UNCERTAIN" });
          else this.applyEvidence(run.runId, evidence);
        });
      } catch {
        this.update(run.runId, "uncertain", { lastError: "ROUTINE_RECOVERY_UNCERTAIN" });
      }
    }
  }

  private watch(runId: string, session: PiSessionHandle): void {
    if (this.subscriptions.has(runId)) return;
    const unsubscribe = session.subscribeRoutineRuns((event) => {
      if (event.runId !== runId) return;
      const patch = {
        ...(event.piEntryId ? { piEntryId: event.piEntryId } : {}),
        ...(event.acceptedTurnId ? { acceptedTurnId: event.acceptedTurnId } : {}),
        ...(event.message ? { lastError: event.message } : {}),
        ...(event.phase === "completed" || event.phase === "failed"
          ? { completedAt: new Date().toISOString() }
          : {}),
      };
      this.update(runId, event.phase, patch);
      if (event.phase === "completed" || event.phase === "failed") {
        unsubscribe();
        this.subscriptions.delete(runId);
      }
    });
    this.subscriptions.set(runId, unsubscribe);
  }

  private applyEvidence(
    runId: string,
    evidence: Exclude<PiRoutineRunEvidence, { state: "not-found" }>,
  ): void {
    if (evidence.state === "accepted" || evidence.state === "running") {
      this.update(runId, evidence.state, {
        piEntryId: evidence.piEntryId,
        ...(evidence.acceptedTurnId ? { acceptedTurnId: evidence.acceptedTurnId } : {}),
      });
      return;
    }
    this.update(runId, evidence.state, {
      piEntryId: evidence.piEntryId,
      ...(evidence.acceptedTurnId ? { acceptedTurnId: evidence.acceptedTurnId } : {}),
      completedAt: new Date().toISOString(),
    });
  }

  private update(
    runId: string,
    state: RoutineRunState,
    fields: {
      piEntryId?: string;
      acceptedTurnId?: string;
      completedAt?: string;
      lastError?: string;
    } = {},
  ): void {
    this.store.updateRoutineRun(runId, { state, ...fields }, new Date().toISOString());
  }
}

/** A stable UUID per routine, used as the chat id of its check realm. */
function checkRealm(routineId: string): string {
  const hex = createHash("sha256").update(`routine-check:${routineId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** One line about what a passing check found, for the notification. */
export function describeCheck(value: unknown): string {
  const items = Array.isArray(value) ? value : (value as { items?: unknown })?.items;
  if (Array.isArray(items) && items.length)
    return `${items.length} new: ${labelOf(items[0])}${items.length > 1 ? " and more" : ""}`;
  return labelOf(value) || "Its check passed.";
}
function labelOf(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 200);
  if (typeof value !== "object" || value === null) return "";
  const record = value as Record<string, unknown>;
  const name = [record.title, record.name, record.text, record.summary].find(
    (field) => typeof field === "string" && field,
  );
  const price = record.price ?? record.amount;
  return [name, price === undefined ? "" : String(price)].filter(Boolean).join(" · ").slice(0, 200);
}

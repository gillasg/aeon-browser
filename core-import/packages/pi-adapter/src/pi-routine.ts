import { randomUUID } from "node:crypto";
import type { AgentSession, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ChatId,
  PiRoutineInvocation,
  PiRoutineRunEvidence,
  PiRoutineRunEvent,
} from "@aeon/domain";
import { PI_ROUTINE_INVOCATION_TYPE, PI_ROUTINE_SETTLEMENT_TYPE } from "./pi-routine-projection.js";
import { isRecord, latestTurnFailed, stringProperty } from "./pi-thread-delivery-evidence.js";
import { resultText } from "./pi-content-projection.js";

export {
  PI_ROUTINE_INVOCATION_TYPE,
  PI_ROUTINE_SETTLEMENT_TYPE,
  projectRoutineInvocation,
  projectRoutineSettlement,
} from "./pi-routine-projection.js";

type Listener = (event: PiRoutineRunEvent) => void;

export interface PiRoutinePort {
  invokeRoutine(input: PiRoutineInvocation): Promise<{ piEntryId: string }>;
  findRoutineRun(runId: string): PiRoutineRunEvidence;
  subscribeRoutineRuns(listener: Listener): () => void;
  close(): void;
}

export function createPiRoutineSupport(
  session: AgentSession,
  manager: SessionManager,
  chatId: ChatId,
): PiRoutinePort {
  return new PiRoutineTracker(session, manager, chatId);
}

type PiSessionEvent = Parameters<AgentSession["subscribe"]>[0] extends (event: infer Event) => void
  ? Event
  : never;
type MessageStartEvent = Extract<PiSessionEvent, { type: "message_start" }>;

class PiRoutineTracker implements PiRoutinePort {
  private readonly listeners = new Set<Listener>();
  private readonly assignedRuns = new Map<string, string>();
  private readonly turnRuns = new Map<string, Set<string>>();
  private readonly resolvedRuns = new Set<string>();
  private readonly submissionTurns = new Map<string, string | undefined>();
  private activeTurnId: string | undefined;
  private readonly unsubscribePi: () => void;

  constructor(
    private readonly session: AgentSession,
    private readonly manager: SessionManager,
    private readonly chatId: ChatId,
  ) {
    this.unsubscribePi = session.subscribe((event) => this.onSessionEvent(event));
    restoreReceipts(manager, this.resolvedRuns);
  }

  async invokeRoutine(input: PiRoutineInvocation): Promise<{ piEntryId: string }> {
    const prior = findInvocation(this.manager, input.runId);
    if (prior) return { piEntryId: prior.id };
    const wasActive = !this.session.isIdle || this.session.isStreaming;
    this.submissionTurns.set(input.runId, wasActive ? this.activeTurnId : undefined);
    await this.session.sendCustomMessage(this.invocationMessage(input), {
      triggerTurn: !wasActive,
      deliverAs: "followUp",
    });
    return this.confirmInvocation(input, wasActive);
  }

  findRoutineRun(runId: string): PiRoutineRunEvidence {
    return findEvidence(this.manager, runId, this.assignedRuns);
  }

  subscribeRoutineRuns(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.unsubscribePi();
    this.listeners.clear();
  }

  private invocationMessage(input: PiRoutineInvocation) {
    return {
      customType: PI_ROUTINE_INVOCATION_TYPE,
      content: `Scheduled routine ${input.title ?? input.routineId} (${input.routineId}), run ${input.runId}, slot ${input.scheduledSlot}. Follow this user-authored instruction:\n\n${input.instruction}`,
      display: true,
      details: {
        kind: PI_ROUTINE_INVOCATION_TYPE,
        runId: input.runId,
        routineId: input.routineId,
        title: input.title,
        scheduledSlot: input.scheduledSlot,
        instruction: input.instruction,
      },
    };
  }

  private confirmInvocation(input: PiRoutineInvocation, wasActive: boolean): { piEntryId: string } {
    const entry = findInvocation(this.manager, input.runId);
    if (!entry) throw new Error("Pi did not persist the exact routine invocation entry.");
    publish(this.listeners, {
      runId: input.runId,
      chatId: this.chatId,
      phase: "accepted",
      piEntryId: entry.id,
    });
    if (!wasActive && this.activeTurnId) this.assign(input.runId, this.activeTurnId, entry.id);
    return { piEntryId: entry.id };
  }

  private onSessionEvent(event: PiSessionEvent): void {
    if (event.type === "turn_start") this.startTurn();
    else if (event.type === "message_start") this.acceptRoutineEntry(event);
    else if (event.type === "turn_end") this.finishTurn();
  }

  private startTurn(): void {
    const turnId = randomUUID();
    this.activeTurnId = turnId;
    this.turnRuns.set(turnId, new Set());
    for (const entry of this.manager.getBranch()) {
      const runId = invocationId(entry);
      if (!runId || this.resolvedRuns.has(runId) || this.assignedRuns.has(runId)) continue;
      this.assign(runId, turnId, entry.id);
      break;
    }
  }

  private acceptRoutineEntry(event: MessageStartEvent): void {
    const details = this.routineDetails(event);
    if (!details) return;
    const runId = stringProperty(details, "runId");
    const entry = runId ? findInvocation(this.manager, runId) : undefined;
    if (!runId || !entry) return;
    publish(this.listeners, { runId, chatId: this.chatId, phase: "accepted", piEntryId: entry.id });
    const submittedDuringTurn = this.submissionTurns.get(runId);
    if (this.activeTurnId && (!submittedDuringTurn || this.activeTurnId !== submittedDuringTurn))
      this.assign(runId, this.activeTurnId, entry.id);
  }

  private routineDetails(event: MessageStartEvent): Record<string, unknown> | undefined {
    if (event.message.role !== "custom" || !isRecord(event.message.details)) return;
    return event.message.details.kind === PI_ROUTINE_INVOCATION_TYPE
      ? event.message.details
      : undefined;
  }

  private assign(runId: string, turnId: string, piEntryId: string): void {
    if (this.resolvedRuns.has(runId) || this.assignedRuns.has(runId)) return;
    this.assignedRuns.set(runId, turnId);
    const runs = this.turnRuns.get(turnId) ?? new Set<string>();
    runs.add(runId);
    this.turnRuns.set(turnId, runs);
    publish(this.listeners, {
      runId,
      chatId: this.chatId,
      phase: "running",
      piEntryId,
      acceptedTurnId: turnId,
    });
  }

  private finishTurn(): void {
    const turnId = this.activeTurnId;
    if (!turnId) return;
    this.activeTurnId = undefined;
    for (const runId of this.turnRuns.get(turnId) ?? []) this.settleRun(runId, turnId);
    this.turnRuns.delete(turnId);
  }

  private settleRun(runId: string, turnId: string): void {
    const entry = findInvocation(this.manager, runId);
    const browserOffline = entry ? browserUnavailableInRun(this.manager, entry.id) : false;
    const failed = latestTurnFailed(this.manager) || browserOffline;
    const phase = failed ? "failed" : "completed";
    this.resolvedRuns.add(runId);
    this.assignedRuns.delete(runId);
    publish(this.listeners, {
      runId,
      chatId: this.chatId,
      phase,
      ...(entry ? { piEntryId: entry.id } : {}),
      acceptedTurnId: turnId,
      ...(failed ? { message: this.failureMessage(browserOffline) } : {}),
    });
    this.manager.appendCustomEntry(PI_ROUTINE_SETTLEMENT_TYPE, {
      runId,
      routineId: entry ? invocationDetails(entry)?.routineId : undefined,
      acceptedTurnId: turnId,
      state: phase,
      piEntryId: entry?.id ?? null,
    });
  }

  private failureMessage(browserOffline: boolean): string {
    return browserOffline
      ? "The routine requested browser work while the browser was disconnected."
      : "The correlated Pi routine turn ended with an error or abort.";
  }
}

function browserUnavailableInRun(manager: SessionManager, invocationEntryId: string): boolean {
  let afterInvocation = false;
  for (const entry of manager.getBranch()) {
    if (!afterInvocation) {
      if (entry.id === invocationEntryId) afterInvocation = true;
      continue;
    }
    if (
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      resultText(entry.message.content).includes("BROWSER_OFFLINE")
    )
      return true;
  }
  return false;
}

function invocationDetails(entry: SessionEntry): Record<string, unknown> | undefined {
  if (
    entry.type !== "custom_message" ||
    entry.customType !== PI_ROUTINE_INVOCATION_TYPE ||
    !isRecord(entry.details)
  )
    return;
  return entry.details;
}

function invocationId(entry: SessionEntry): string | undefined {
  const details = invocationDetails(entry);
  return details ? stringProperty(details, "runId") : undefined;
}

function findInvocation(manager: SessionManager, runId: string): SessionEntry | undefined {
  return manager.getEntries().find((entry) => invocationId(entry) === runId);
}

function findEvidence(
  manager: SessionManager,
  runId: string,
  assignedRuns: ReadonlyMap<string, string>,
): PiRoutineRunEvidence {
  for (const entry of manager.getEntries()) {
    const evidence = settlementEvidence(entry, runId);
    if (evidence) return evidence;
  }
  const invocation = findInvocation(manager, runId);
  if (!invocation) return { state: "not-found" };
  const acceptedTurnId = assignedRuns.get(runId);
  return {
    state: acceptedTurnId ? "running" : "accepted",
    piEntryId: invocation.id,
    ...(acceptedTurnId ? { acceptedTurnId } : {}),
  };
}

function settlementEvidence(entry: SessionEntry, runId: string): PiRoutineRunEvidence | undefined {
  if (entry.type !== "custom" || entry.customType !== PI_ROUTINE_SETTLEMENT_TYPE) return;
  if (!isRecord(entry.data) || entry.data.runId !== runId) return;
  if (
    (entry.data.state === "completed" || entry.data.state === "failed") &&
    typeof entry.data.acceptedTurnId === "string" &&
    typeof entry.data.piEntryId === "string"
  )
    return {
      state: entry.data.state,
      piEntryId: entry.data.piEntryId,
      acceptedTurnId: entry.data.acceptedTurnId,
    };
}

function restoreReceipts(manager: SessionManager, resolvedRuns: Set<string>): void {
  for (const entry of manager.getEntries()) {
    if (
      entry.type === "custom" &&
      entry.customType === PI_ROUTINE_SETTLEMENT_TYPE &&
      isRecord(entry.data) &&
      typeof entry.data.runId === "string"
    )
      resolvedRuns.add(entry.data.runId);
  }
}

function publish(listeners: ReadonlySet<Listener>, event: PiRoutineRunEvent): void {
  for (const listener of listeners) listener(event);
}

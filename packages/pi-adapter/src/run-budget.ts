import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PiRunBudget } from "@graft/domain";
import { markRunAborted, streamRetrySlot } from "./stream-retry.js";

// A run's limits (steps, minutes, cost). A minute budget keeps the smaller of 10% and 30s for a
// delivery-only turn: tools are cleared and cells stop before that window, with no injected user
// text. At the limit the agent is told to stop and, after two more tool steps, the run aborts.

const GRACE_STEPS = 2;
/** browser-code-cells cuts a cell at timeoutMs plus this grace. The cap leaves room for it. */
const CELL_EXPIRE_GRACE_MS = 5_000;
const RESERVE_CAP_MS = 30_000;

type ModelStream = AgentSession["agent"]["streamFunction"];
type Clock = { started: number; budgetMs: number; now: () => number; delivering: boolean };

const clocks = new Map<string, Clock>();
const cappedStreams = new WeakSet<ModelStream>();

export function deliveryReserveMs(budgetMs: number): number {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return 0;
  return Math.min(budgetMs * 0.1, RESERVE_CAP_MS);
}

/** How long a cell may run. Zero means it must not start: the delivery window is open. */
export function cellTimeoutMs(chatId: string, capMs: number): number {
  const clock = clocks.get(chatId);
  if (!clock) return capMs;
  if (clock.delivering) return 0;
  const left = deliveryAt(clock) - clock.now();
  if (left <= CELL_EXPIRE_GRACE_MS) return 0;
  return Math.min(capMs, left - CELL_EXPIRE_GRACE_MS);
}

/** Milliseconds a model request may run, or undefined when this chat has no minute budget. */
export function modelRequestTimeoutMs(chatId: string): number | undefined {
  const clock = clocks.get(chatId);
  if (!clock) return undefined;
  const now = clock.now();
  const end = clock.started + clock.budgetMs;
  const limit = clock.delivering || now >= deliveryAt(clock) ? end : deliveryAt(clock);
  return Math.max(1, limit - now);
}

function deliveryAt(clock: Clock): number {
  return clock.started + clock.budgetMs - deliveryReserveMs(clock.budgetMs);
}

function costOf(message: unknown): number {
  const total = (message as { usage?: { cost?: { total?: unknown } } } | undefined)?.usage?.cost
    ?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

function reachedLimit(
  budget: PiRunBudget,
  state: { steps: number; cost: number; started: number },
  now: number,
): string | undefined {
  if (budget.maxSteps && state.steps >= budget.maxSteps) return `${budget.maxSteps} steps`;
  if (budget.maxMinutes && now - state.started >= budget.maxMinutes * 60_000)
    return `${budget.maxMinutes} minutes`;
  if (budget.maxCost && state.cost >= budget.maxCost) return `$${budget.maxCost}`;
  return undefined;
}

function reserveOpen(budget: PiRunBudget, started: number, now: number): boolean {
  if (!budget.maxMinutes || budget.maxMinutes <= 0) return false;
  const budgetMs = budget.maxMinutes * 60_000;
  return now - started >= budgetMs - deliveryReserveMs(budgetMs);
}

function steerText(limit: string): string {
  return `[Budget reached: ${limit}.] Stop using tools now. Answer in this turn with what you have: what is done, what is not, and the best partial result (checkpoints saved with {partial: true} are in the workspace under partial/).`;
}

function deadlineSignal(
  parent: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.round(ms)));
  const onParent = () => controller.abort();
  parent?.addEventListener("abort", onParent, { once: true });
  if (parent?.aborted) controller.abort();
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

function watchStreamEnd(stream: { result?: () => Promise<unknown> }, cancel: () => void): void {
  if (typeof stream.result === "function") void stream.result().finally(cancel);
}

function settleDeadline(
  stream: ReturnType<ModelStream>,
  cancel: () => void,
): ReturnType<ModelStream> {
  if (stream instanceof Promise) {
    return stream.then((value) => {
      watchStreamEnd(value, cancel);
      return value;
    });
  }
  watchStreamEnd(stream, cancel);
  return stream;
}

function capModelStream(session: AgentSession, chatId: string): void {
  const agent = session.agent;
  if (!agent?.streamFunction) return;
  // Stream retry stays outside this deadline so it still sees the loop signal. A minute
  // budget aborts only the provider call; that is not a dropped stream to retry.
  const slot = streamRetrySlot(agent.streamFunction);
  const inner = slot?.fn ?? agent.streamFunction;
  if (!inner || cappedStreams.has(inner)) return;
  const wrapped: ModelStream = (model, context, options) => {
    const timeout = modelRequestTimeoutMs(chatId);
    if (timeout === undefined) return inner(model, context, options);
    const timed = deadlineSignal(options?.signal, timeout);
    const stream = inner.call(agent, model, context, { ...options, signal: timed.signal });
    return settleDeadline(stream, timed.cancel);
  };
  cappedStreams.add(wrapped);
  if (slot) slot.fn = wrapped;
  else agent.streamFunction = wrapped;
}

function openDelivery(session: AgentSession, chatId: string | undefined): void {
  const clock = chatId ? clocks.get(chatId) : undefined;
  if (clock) clock.delivering = true;
  session.setActiveToolsByName([]);
}

export function watchBudget(
  session: AgentSession,
  budget: PiRunBudget,
  chatId?: string,
  now: () => number = Date.now,
): void {
  const state = { steps: 0, cost: 0, started: now() };
  let warnedAt: number | undefined;
  let delivering = false;
  if (chatId && budget.maxMinutes && budget.maxMinutes > 0) {
    clocks.set(chatId, {
      started: state.started,
      budgetMs: budget.maxMinutes * 60_000,
      now,
      delivering: false,
    });
    capModelStream(session, chatId);
  }
  const check = () => {
    if (warnedAt !== undefined) {
      if (state.steps > warnedAt + GRACE_STEPS) {
        markRunAborted(session);
        void session.abort();
      }
      return;
    }
    if (!delivering && reserveOpen(budget, state.started, now())) {
      delivering = true;
      openDelivery(session, chatId);
    }
    const limit = reachedLimit(budget, state, now());
    if (!limit) return;
    warnedAt = state.steps;
    void session.steer(steerText(limit));
  };
  const timer = budget.maxMinutes
    ? setInterval(check, Math.min(budget.maxMinutes * 60_000, 5_000))
    : undefined;
  timer?.unref();
  const stop = session.subscribe((event) => {
    if (event.type === "tool_execution_end") state.steps += 1;
    if (event.type === "message_end") state.cost += costOf(event.message);
    if (event.type === "agent_end") {
      if (timer) clearInterval(timer);
      if (chatId) clocks.delete(chatId);
      stop();
      return;
    }
    check();
  });
}

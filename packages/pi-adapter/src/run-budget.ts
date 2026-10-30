import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PiRunBudget } from "@aeon/domain";

// A run's limits (steps, minutes, cost). When one is reached the agent is told to stop using
// tools and deliver what it has, from its partial checkpoints too; if it keeps calling tools the
// run is stopped. The limits count from the prompt and end with the run.

const GRACE_STEPS = 2;

function costOf(message: unknown): number {
  const total = (message as { usage?: { cost?: { total?: unknown } } } | undefined)?.usage?.cost
    ?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

function reachedLimit(
  budget: PiRunBudget,
  state: { steps: number; cost: number; started: number },
): string | undefined {
  if (budget.maxSteps && state.steps >= budget.maxSteps) return `${budget.maxSteps} steps`;
  if (budget.maxMinutes && Date.now() - state.started >= budget.maxMinutes * 60_000)
    return `${budget.maxMinutes} minutes`;
  if (budget.maxCost && state.cost >= budget.maxCost) return `$${budget.maxCost}`;
  return undefined;
}

export function watchBudget(session: AgentSession, budget: PiRunBudget): void {
  const state = { steps: 0, cost: 0, started: Date.now() };
  let warnedAt: number | undefined;
  const check = () => {
    if (warnedAt !== undefined) {
      if (state.steps > warnedAt + GRACE_STEPS) void session.abort();
      return;
    }
    const limit = reachedLimit(budget, state);
    if (!limit) return;
    warnedAt = state.steps;
    void session.steer(
      `[Budget reached: ${limit}.] Stop using tools now. Answer in this turn with what you have: what is done, what is not, and the best partial result (checkpoints saved with {partial: true} are in the workspace under partial/).`,
    );
  };
  const timer = budget.maxMinutes
    ? setInterval(check, Math.min(budget.maxMinutes * 60_000, 15_000))
    : undefined;
  const stop = session.subscribe((event) => {
    if (event.type === "tool_execution_end") state.steps += 1;
    if (event.type === "message_end") state.cost += costOf(event.message);
    if (event.type === "agent_end") {
      if (timer) clearInterval(timer);
      stop();
      return;
    }
    check();
  });
}

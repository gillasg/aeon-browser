// Picks the debugger-free path for a read step when it can take one (native-browser-tier0.ts).
import type { BrowserExecutorRequest } from "@browserkit/protocol";
import { browserDebuggerAttached } from "./native-browser-session.js";
import { runTier0, tier0Eligible, tier0Extract, tier0Plan } from "./native-browser-tier0.js";

/** The step's data from the isolated world, or undefined when it must go through CDP. */
export async function tier0Step(
  request: BrowserExecutorRequest,
  revalidate: () => Promise<void>,
): Promise<unknown> {
  const step = request.step;
  if (step.op !== "read" && step.op !== "evaluate") return undefined;
  const tabId = step.target.tabId;
  const plan = step.op === "evaluate" ? tier0Plan(step.expression) : undefined;
  if (step.op === "evaluate" && !plan) return undefined;
  if (!(await tier0Eligible(tabId, browserDebuggerAttached(tabId)))) return undefined;
  await revalidate();
  if (step.op === "read")
    return tier0Extract(tabId, step.selector, step.limit, step.textLimit, step.attributes);
  const done = plan ? await runTier0(tabId, plan) : undefined;
  // A read-only reader leaves the page as it was: no fresh observation is needed afterwards.
  return done ? { value: done.value, changed: false } : undefined;
}

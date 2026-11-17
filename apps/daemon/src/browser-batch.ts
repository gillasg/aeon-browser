import { randomUUID } from "node:crypto";
import {
  BrowserOperationCallSchema,
  INPUT_MAY_HAVE_LANDED_NOTE,
  type BrowserStep,
  type BrowserExecutorResult,
} from "@aeon/protocol";

// A click, type, press or fill that was sent and then failed or timed out may already have landed.
const WRITE_OPS = new Set(["click", "fill", "paste", "type", "press", "select", "check", "upload"]);
const SENT_THEN_FAILED = new Set([
  "TIMEOUT",
  "CHROME_ERROR",
  "TAB_UNRESPONSIVE",
  "TAB_DEAD",
  "NETWORK",
  "SITE_BROKEN",
  "RATE_LIMITED",
  "INTERNAL",
  "INPUT_FAILED",
  "INPUT_MAY_HAVE_LANDED",
]);

/** Drops a retry suggestion from an error detail once the action may have applied. */
function withoutNext(detail: string): string {
  return detail
    .split("\n")
    .filter((line) => !/^Next:/.test(line))
    .join("\n");
}

/** The failed step line: a sent write carries an unknown effect and no hint to repeat it. */
function failedStep(
  index: number,
  outcome: { code?: string; detail?: string },
  write: boolean,
): Record<string, unknown> {
  const code = outcome.code ?? "INTERNAL";
  const mayLanded = write && SENT_THEN_FAILED.has(code);
  const detail = mayLanded
    ? [outcome.detail && withoutNext(outcome.detail), INPUT_MAY_HAVE_LANDED_NOTE]
        .filter(Boolean)
        .join("\n")
    : outcome.detail;
  return {
    index,
    disposition: "failed",
    code,
    ...(mayLanded ? { effect: "unverifiable" } : {}),
    ...(detail ? { detail } : {}),
  };
}

export async function executeBrowserBatch(
  raw: unknown,
  toolCallId: string,
  execute: (
    id: string,
    step: BrowserStep,
    timeout: number,
  ) => Promise<{ result?: BrowserExecutorResult; code?: string; detail?: string }>,
  signal?: AbortSignal,
): Promise<string> {
  const parsed = BrowserOperationCallSchema.safeParse(raw);
  if (!parsed.success)
    return JSON.stringify({
      error: "INVALID_TARGET",
      detail: "Browser arguments did not match the operation schema.",
    });
  const operationId = randomUUID(),
    deadline = Date.now() + 30_000;
  const steps: Record<string, unknown>[] = [];
  for (const [index, step] of parsed.data.steps.entries()) {
    if (Date.now() >= deadline || signal?.aborted) {
      steps.push({ index, disposition: "failed", code: signal?.aborted ? "CANCELLED" : "TIMEOUT" });
      break;
    }
    const outcome = await execute(operationId, step, Math.min(12_000, deadline - Date.now()));
    steps.push(
      outcome.result
        ? { index, disposition: "completed", result: outcome.result }
        : failedStep(index, outcome, WRITE_OPS.has(step.op)),
    );
    if (!outcome.result) {
      for (let next = index + 1; next < parsed.data.steps.length; next++)
        steps.push({ index: next, disposition: "skipped", code: "STOPPED_AFTER_ERROR" });
      break;
    }
  }
  return JSON.stringify({ operationId, toolCallId, steps });
}

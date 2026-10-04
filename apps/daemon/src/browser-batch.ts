import { randomUUID } from "node:crypto";
import {
  BrowserOperationCallSchema,
  type BrowserStep,
  type BrowserExecutorResult,
} from "@pippin/protocol";
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
        : {
            index,
            disposition: "failed",
            code: outcome.code ?? "OPERATION_FAILED",
            detail: outcome.detail,
          },
    );
    if (!outcome.result) {
      for (let next = index + 1; next < parsed.data.steps.length; next++)
        steps.push({ index: next, disposition: "skipped", code: "STOPPED_AFTER_ERROR" });
      break;
    }
  }
  return JSON.stringify({ operationId, toolCallId, steps });
}

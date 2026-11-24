// The code a job realm runs, written where the realm runs (the local Aeon process): the item
// function for browser.job, or the generated sweep. The extension sends only the job's spec.
import { jobCode, type JobOptions } from "./code-job-code.js";
import { sweepCode, type SweepOptions } from "./code-sweep-code.js";
import { judgeOutcome, registrableDomain } from "./outcomes.js";

export function jobSource(spec: Record<string, unknown>): string {
  const offset = typeof spec.offset === "number" && spec.offset > 0 ? spec.offset : undefined;
  const jobId = String(spec.jobId ?? "");
  const items = Array.isArray(spec.items) ? (spec.items as unknown[]) : [];
  if (spec.mode === "sweep")
    return sweepCode({
      jobId,
      urls: items,
      options: spec.options as SweepOptions,
      ...(offset ? { offset } : {}),
      judge: judgeOutcome.toString(),
      domain: registrableDomain.toString(),
    });
  return jobCode({
    jobId,
    items,
    fn: String(spec.fn ?? ""),
    options: spec.options as JobOptions,
    ...(offset ? { offset } : {}),
  });
}

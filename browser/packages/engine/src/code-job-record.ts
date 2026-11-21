// The durable job record a caller can still read after the worker drops the realm. Kept free of
// chrome so the reason and the id rules can be tested on their own.

export const DROPPED_JOB_REASON = "the worker dropped this job before it finished; start it again";

/** A job id from a string, a number, or the object browser.job.start returned. */
export function jobIdOf(request: Record<string, unknown>): string {
  const raw = request.id ?? request.jobId;
  if (raw && typeof raw === "object") {
    const nested = (raw as Record<string, unknown>).jobId ?? (raw as Record<string, unknown>).id;
    if (typeof nested === "string" || typeof nested === "number") return String(nested);
  }
  if (typeof raw === "string" || typeof raw === "number") return String(raw);
  return "";
}

/** What status returns when the record is gone: a lost job, with one line saying why. */
export function missingJob(id: string): Record<string, unknown> {
  return {
    jobId: id,
    status: "lost",
    state: "lost",
    done: 0,
    total: 0,
    error: DROPPED_JOB_REASON,
  };
}

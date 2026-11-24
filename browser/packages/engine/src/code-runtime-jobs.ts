// Browser jobs outlive the cell that started them: their state is kept in session storage and
// restored when the worker restarts, so browser.job status still answers.
import type { Cell } from "./code-runtime-host.js";
import type { JobOptions } from "./code-job-code.js";
import type { SweepOptions } from "./code-sweep-code.js";
import type { BrowserIdentity } from "./native-worker-identity.js";

export const jobs = new Map<string, Job>();
/** Watchdogs for running jobs; a job whose realm is gone is settled by one. */
export const jobTimers = new Map<string, ReturnType<typeof setTimeout>>();
const JOB_STORAGE = "aeon-code-jobs";
export const MAX_JOB_ITEM_CHARS = 200_000;
/** Settled jobs kept, newest first; older ones are dropped from memory and from storage. */
export const MAX_FINISHED_JOBS = 20;
/**
 * Bytes of results and items all saved jobs may take together. chrome.storage.session holds 10 MB
 * for the whole extension, and a write past it fails whole, so stay well under it.
 */
export const SAVED_JOBS_BUDGET = 4_000_000;
const TRIMMED = "results too large to keep; run the job again for them";

export interface Job extends Cell {
  status: "running" | "complete" | "failed" | "cancelled" | "lost";
  startedAt: number;
  finishedAt?: number;
  total: number;
  results?: unknown[];
  progress?: { done: number; total: number; label?: string };
  error?: string;
  artifact?: string;
  /** The items and function a resume replays; a lost job keeps them. */
  items?: unknown[];
  fn?: string;
  options?: JobOptions | SweepOptions;
  /** A job of pages, or a sweep with outcomes and evidence per URL. */
  mode?: "job" | "sweep";
}

let jobsRestored: Promise<void> | undefined;
export function restoreJobs(): Promise<void> {
  if (jobsRestored) return jobsRestored;
  // A failed read must not stick: the next status call reads again, and a save must not write an
  // empty map over jobs that are still in storage. Only this read may clear the cache, so a newer
  // reload is not dropped when an older read fails.
  const reading = chrome.storage.session
    .get(JOB_STORAGE)
    .then((stored) => {
      const saved = stored[JOB_STORAGE];
      if (!Array.isArray(saved)) return;
      for (const item of saved as Record<string, unknown>[]) {
        if (typeof item.jobId !== "string" || jobs.has(item.jobId)) continue;
        jobs.set(item.jobId, {
          ...emptyJob(item.jobId, String(item.chatId ?? ""), Number(item.total ?? 0)),
          // A job that was still running when the worker or browser restarted cannot be resumed:
          // it is lost, not failed, so a caller can tell the difference.
          status:
            item.status === "complete" || item.status === "failed" || item.status === "cancelled"
              ? item.status
              : "lost",
          ...(item.status === "lost" ||
          !["complete", "failed", "cancelled"].includes(String(item.status))
            ? { error: "the job's cell is gone (browser or worker restarted); start it again" }
            : {}),
          startedAt: Number(item.startedAt ?? Date.now()),
          ...(item.finishedAt ? { finishedAt: Number(item.finishedAt) } : {}),
          ...(Array.isArray(item.results) ? { results: item.results } : {}),
          ...(item.progress && typeof item.progress === "object"
            ? {
                progress: {
                  done: Number((item.progress as { done?: unknown }).done ?? 0),
                  total: Number((item.progress as { total?: unknown }).total ?? item.total ?? 0),
                },
              }
            : {}),
          ...(Array.isArray(item.items) ? { items: item.items } : {}),
          ...(typeof item.fn === "string" ? { fn: item.fn } : {}),
          ...(item.options && typeof item.options === "object"
            ? { options: item.options as JobOptions | SweepOptions }
            : {}),
          ...(item.mode === "sweep" ? { mode: "sweep" as const } : {}),
          ...(typeof item.error === "string" ? { error: item.error } : {}),
          ...(typeof item.artifact === "string" ? { artifact: item.artifact } : {}),
        });
      }
    })
    .catch((error: unknown) => {
      if (jobsRestored === reading) jobsRestored = undefined;
      throw error;
    });
  jobsRestored = reading;
  return reading;
}

/** Reads storage again and merges anything this worker has not seen yet. */
export function reloadJobs(): Promise<void> {
  jobsRestored = undefined;
  return restoreJobs().catch(() => undefined);
}

export function emptyJob(jobId: string, chatId: string, total: number): Job {
  return {
    run: {
      kind: "browser.code.run",
      cellId: jobId,
      chatId,
      toolCallId: "job-" + jobId,
      code: "browser.job",
      targets: [],
      timeoutMs: 600_000,
    },
    socket: undefined as unknown as WebSocket,
    identity: undefined as unknown as BrowserIdentity,
    operationId: crypto.randomUUID(),
    allowed: new Map(),
    opened: new Map(),
    guarded: new Set(),
    steps: [],
    events: [],
    count: 0,
    calls: new Map(),
    sequence: 0,
    progressTimer: undefined,
    waitingForUser: false,
    done: true,
    popupsAtStart: 0,
    status: "complete",
    startedAt: Date.now(),
    total,
  };
}

function sizeOf(value: unknown): number {
  try {
    return (JSON.stringify(value) ?? "").length;
  } catch {
    // A value that cannot be stored must not drop the record itself.
    return Number.POSITIVE_INFINITY;
  }
}

/** Drops settled jobs past the newest MAX_FINISHED_JOBS; running jobs are always kept. */
export function pruneJobs(): void {
  const settled = [...jobs.values()]
    .filter((job) => job.status !== "running")
    .sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt));
  for (const job of settled.slice(MAX_FINISHED_JOBS)) {
    jobs.delete(job.run.cellId);
    const timer = jobTimers.get(job.run.cellId);
    if (timer) clearTimeout(timer);
    jobTimers.delete(job.run.cellId);
  }
}

/**
 * The records written to storage. Running jobs, then the newest settled ones, get their results
 * and items while the total fits SAVED_JOBS_BUDGET; past it a job keeps its status and says why
 * its results are gone, so a status call still answers instead of the whole write failing.
 */
export function savedJobRecords(): Record<string, unknown>[] {
  const ordered = [...jobs.values()].sort((a, b) => {
    const running = Number(b.status === "running") - Number(a.status === "running");
    return running || (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt);
  });
  let spent = 0;
  const fits = (value: unknown): boolean => {
    const size = sizeOf(value);
    if (size > 1_000_000 || spent + size > SAVED_JOBS_BUDGET) return false;
    spent += size;
    return true;
  };
  return ordered.map((job) => {
    const results = job.results && fits(job.results) ? job.results : undefined;
    const items = job.items && job.items.length <= 500 && fits(job.items) ? job.items : undefined;
    const trimmed = Boolean(job.results && !results);
    const error = job.error ?? (trimmed && job.status !== "running" ? TRIMMED : undefined);
    return {
      jobId: job.run.cellId,
      chatId: job.run.chatId,
      status: job.status,
      total: job.total,
      startedAt: job.startedAt,
      ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
      ...(results ? { results } : {}),
      ...(job.progress ? { progress: job.progress } : {}),
      ...(items ? { items } : {}),
      ...(job.fn ? { fn: job.fn } : {}),
      ...(job.options ? { options: job.options } : {}),
      ...(job.mode ? { mode: job.mode } : {}),
      ...(error ? { error } : {}),
      ...(job.artifact ? { artifact: job.artifact } : {}),
    };
  });
}

let jobsWriting = Promise.resolve();
export function saveJobs(): Promise<void> {
  jobsWriting = jobsWriting
    .catch(() => undefined)
    .then(async () => {
      // Restore first, so a save during startup cannot replace stored jobs with an empty map.
      try {
        await restoreJobs();
      } catch {
        return;
      }
      pruneJobs();
      await chrome.storage.session.set({ [JOB_STORAGE]: savedJobRecords() });
    })
    .catch((error: unknown) => {
      // A failed write leaves the last good copy in storage; say so rather than lose jobs quietly.
      console.warn("browser jobs: saving job state failed:", String(error));
    });
  return jobsWriting;
}

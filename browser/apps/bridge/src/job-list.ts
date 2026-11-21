// Merging browser.job answers when more than one Chrome is connected. A job lives in the
// browser that started it, so a list with no --browser asks each one and keeps the better record.

export interface JobView {
  jobId?: string;
  status?: string;
  state?: string;
  mode?: string;
  done?: number;
  total?: number;
  error?: string;
  note?: string;
  summary?: { counts?: Record<string, number>; warning?: string };
}

const RANK: Record<string, number> = {
  running: 0,
  complete: 1,
  failed: 2,
  cancelled: 3,
  lost: 4,
};

export function ambiguousBrowser(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Several browsers are connected") || message.includes("AMBIGUOUS_BROWSER")
  );
}

/** A name when the user gave one, otherwise the browser id, which pin accepts as a prefix. */
export function browserNames(reply: unknown): string[] {
  const browsers = (reply as { browsers?: { name?: string; clientInstanceId?: string }[] })
    ?.browsers;
  if (!Array.isArray(browsers)) return [];
  return browsers
    .map((item) => item.name || item.clientInstanceId)
    .filter((name): name is string => Boolean(name));
}

/** A live or finished job beats the lost record another browser returns for the same id. */
export function preferJob(jobs: JobView[]): JobView | undefined {
  const ranked = jobs.filter((job) => job && (job.jobId || job.status));
  ranked.sort((left, right) => (RANK[left.status ?? ""] ?? 3) - (RANK[right.status ?? ""] ?? 3));
  return ranked[0];
}

export function mergeJobLists(groups: JobView[][]): JobView[] {
  const byId = new Map<string, JobView>();
  for (const group of groups)
    for (const job of group) {
      const id = job.jobId ?? "";
      const prior = byId.get(id);
      byId.set(id, prior ? (preferJob([prior, job]) ?? job) : job);
    }
  return [...byId.values()];
}

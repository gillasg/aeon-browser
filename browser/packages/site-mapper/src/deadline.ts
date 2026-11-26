// A bounded wait: heal re-reads bundles and probes live calls, which on a slow or walled site
// can run for minutes. Past its budget it answers with a clear decline instead of hanging.

/** The heal budget (ms); SITE_MAPPER_HEAL_DEADLINE_MS overrides it. */
export function healDeadlineMs(): number {
  const raw = Number(process.env.SITE_MAPPER_HEAL_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

/** The work's answer, or `late` when it takes longer than `ms`. The work is left to settle. */
export async function withDeadline<T, L>(work: Promise<T>, ms: number, late: L): Promise<T | L> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<L>((resolve) => {
    timer = setTimeout(() => resolve(late), ms);
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const HEAL_TIMEOUT = { healed: false as const, declined: "timeout" as const };

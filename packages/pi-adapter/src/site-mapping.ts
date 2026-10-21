// Background mapping was removed: no model runs on the user's sites without an explicit request.
// The exports remain for the existing call sites; they are intentionally inert.

/** The URLs a browser_code cell opened or moved to. */
export function visitedUrls(steps: Record<string, unknown>[]): string[] {
  const urls: string[] = [];
  for (const step of steps) {
    const action = step.action as { url?: unknown } | undefined;
    const tab = (step.result as { tab?: { url?: unknown } } | undefined)?.tab;
    for (const url of [action?.url, tab?.url]) if (typeof url === "string") urls.push(url);
  }
  return urls;
}

/** Kept for the existing call site; background mapping is off. */
export function installSiteMapping(file: string, model: () => Promise<unknown>): void {
  void file;
  void model;
}

/** Kept for the existing call site; visits are no longer recorded. */
export function noteVisits(chatId: string, urls: string[]): void {
  void chatId;
  void urls;
}

/** Kept for the existing call site; failed calls are no longer re-recorded in the background. */
export function repairSoon(site: string, operation: string, error: unknown): void {
  void site;
  void operation;
  void error;
}

/** Nothing is pending. */
export const mappingSettled = (): Promise<void> => Promise.resolve();

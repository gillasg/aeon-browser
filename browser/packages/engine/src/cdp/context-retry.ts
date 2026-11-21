// A frame that navigates or reloads between the moment an execution context is made (or looked
// up) and the call that uses it answers "Cannot find context with specified id" or "Execution
// context was destroyed". Nothing is wrong with the script: the context it was aimed at is gone.
// The caller makes a fresh one after a short pause and tries again, a bounded number of times.
// An exception thrown by the script itself is a result, not one of these, and is never retried.

const GONE =
  /Cannot find context with specified id|Execution context was destroyed|Cannot find default execution context|Inspected target navigated or closed/i;
const RETRIES = 2;
const BACKOFF_MS = 60;

/** True for a CDP error that means the execution context went away mid-call. */
export function isContextGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return GONE.test(message);
}

export interface ContextRetryOptions {
  retries?: number;
  backoffMs?: number;
  /** Runs before each retry: drop the cached context id here. */
  invalidate?: () => void;
}

/**
 * Runs `attempt`, and again (up to `retries` more times, with a growing pause) when it fails
 * because its context vanished. Any other failure goes straight to the caller.
 */
export async function withContextRetry<T>(
  attempt: () => Promise<T>,
  options: ContextRetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? RETRIES;
  const backoff = options.backoffMs ?? BACKOFF_MS;
  for (let tried = 0; ; tried++) {
    try {
      return await attempt();
    } catch (error) {
      if (tried >= retries || !isContextGone(error)) throw error;
      options.invalidate?.();
      await new Promise((done) => setTimeout(done, backoff * (tried + 1)));
    }
  }
}

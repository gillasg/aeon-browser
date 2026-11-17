// After the daemon (or Aeon) restarts, the extension takes a moment to pair again. A status
// reply that reports "no browser" immediately is a dead end, so wait briefly for a browser that
// is on its way back. The wait is bounded and only happens when there is no browser at all.

const POLL_MS = 250;
const DEFAULT_WAIT_MS = 3000;

/**
 * Polls `settings` until a browser is connected or the wait expires. Returns the last reply so
 * callers keep their existing shape. Callers decide what to say when the list is still empty —
 * "reconnecting" is only honest for a browser that was paired and has gone away, which the link
 * state in the extension reports; here we simply stop the premature "no browser" answer.
 */
export async function waitForBrowser(
  settings: () => Promise<unknown[]>,
  timeoutMs = DEFAULT_WAIT_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<unknown[]> {
  const started = Date.now();
  let browsers = await settings();
  while (!browsers.length && Date.now() - started < timeoutMs) {
    await sleep(POLL_MS);
    browsers = await settings();
  }
  return browsers;
}

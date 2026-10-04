let timer: number | undefined;
let attempts = 0;
/** Re-establish the browser executor without replaying any browser operation. */
export function scheduleExecutorReconnect(connect: () => Promise<unknown>): void {
  if (timer !== undefined) return;
  const delay = Math.min(250 * 2 ** Math.min(attempts++, 3), 2000);
  timer = globalThis.setTimeout(() => {
    timer = undefined;
    void connect().then(
      () => {
        attempts = 0;
      },
      () => scheduleExecutorReconnect(connect),
    );
  }, delay);
}

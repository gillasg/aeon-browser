// The supervisor kills a daemon that leaves a bootstrap unanswered for 15 s, which ends every
// running chat. A blocked event loop is the usual cause, so every block of a second or more is
// logged (to the supervisor log) with how long it lasted, and the next one names itself.
const TICK_MS = 250;
const REPORT_MS = 1000;

export function watchStalls(
  log: (message: string) => void = (message) => process.stderr.write(message + "\n"),
  now: () => number = () => Date.now(),
): () => void {
  let last = now();
  const timer = setInterval(() => {
    const at = now();
    const late = at - last - TICK_MS;
    last = at;
    if (late >= REPORT_MS)
      log(
        `Aeon daemon: event loop blocked ${late} ms (heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB)`,
      );
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

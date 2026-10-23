// The daemon hosts third-party Pi extensions. One stray rejection or throw inside an extension
// must not end every chat, so these are logged and the daemon keeps serving. A burst of
// uncaught exceptions means state may be corrupt: then exit and let the supervisor restart.
const BURST_LIMIT = 5;
const BURST_WINDOW_MS = 60_000;

export function installProcessGuard(
  log: (message: string) => void = (message) => process.stderr.write(message + "\n"),
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  const recent: number[] = [];
  process.on("unhandledRejection", (reason) => {
    log("Aeon daemon: unhandled rejection kept running: " + describe(reason));
  });
  process.on("uncaughtException", (error) => {
    const now = Date.now();
    recent.push(now);
    while (recent.length && (recent[0] ?? now) < now - BURST_WINDOW_MS) recent.shift();
    log("Aeon daemon: uncaught exception: " + describe(error));
    if (recent.length >= BURST_LIMIT) {
      log("Aeon daemon: repeated uncaught exceptions; restarting.");
      exit(1);
    }
  });
}

function describe(value: unknown): string {
  const text = value instanceof Error ? (value.stack ?? value.message) : String(value);
  return text.slice(0, 2000);
}

import { writeSync } from "node:fs";

const FAILURE_PREFIX = "AEON_DAEMON_FAILED ";

/** One line the supervisor stores as the cause. Newlines would split the protocol. */
export function managedFailureLine(message: string): string {
  const oneLine = message.replace(/[\r\n]+/g, " ").slice(0, 2000);
  return `${FAILURE_PREFIX}${oneLine}\n`;
}

/**
 * Writes the cause on the real stdout descriptor. `process.stdout.write` is redirected to
 * stderr once the supervisor protocol is reserved, and stderr is only a log.
 */
export function reportManagedFailure(message: string): void {
  writeSync(1, managedFailureLine(message));
}

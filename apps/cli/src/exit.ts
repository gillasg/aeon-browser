// process.exit() drops whatever stdout and stderr still hold for a pipe: an agent or script that
// reads `graft repl` through a pipe got a large result cut off mid-JSON (writes to a file or a TTY
// are synchronous and were never affected). Exit only after both streams have flushed — but with
// a hard cap: a command that just closed a WebSocket can otherwise sit on an async drain callback
// that never fires, holding a command substitution's stdout pipe open for minutes.

function drained(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || !stream.writable) return resolve();
    // Writes are ordered: the callback of an empty write runs after every earlier chunk is out.
    stream.write("", () => resolve());
  });
}

/** Exits with `code` once stdout and stderr are flushed, or after the cap at the latest. */
export async function exitAfterFlush(code: number, capMs = 30_000): Promise<never> {
  process.exitCode = code;
  // Unref'd: when nothing else holds the loop open the process exits on its own, with this code.
  // When something does (a close handshake, a stray interval), this forces the exit. The cap is
  // generous enough for a slow first `graft doctor` against a just-started daemon, and far below a
  // stuck drain holding a command substitution open.
  const watchdog = setTimeout(() => process.exit(code), capMs);
  watchdog.unref();
  try {
    await Promise.all([drained(process.stdout), drained(process.stderr)]);
  } finally {
    clearTimeout(watchdog);
  }
  process.exit(code);
}

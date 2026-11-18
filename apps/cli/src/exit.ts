// process.exit() drops whatever stdout and stderr still hold for a pipe: an agent or script that
// reads `aeon repl` through a pipe got a large result cut off mid-JSON (writes to a file or a TTY
// are synchronous and were never affected). Exit only after both streams have flushed.

function drained(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || !stream.writable) return resolve();
    // Writes are ordered: the callback of an empty write runs after every earlier chunk is out.
    stream.write("", () => resolve());
  });
}

/** Exits with `code` once stdout and stderr are flushed. */
export async function exitAfterFlush(code: number): Promise<never> {
  process.exitCode = code;
  await Promise.all([drained(process.stdout), drained(process.stderr)]);
  process.exit(code);
}

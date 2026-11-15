import readline from "node:readline";

/** One outstanding read at a time, like the C# supervisor: a timed-out read loses nothing. */
export function createLineReader(stream) {
  const lines = [];
  const waiters = [];
  let closed = false;
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  reader.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter({ kind: "line", line });
    else lines.push(line);
  });
  const close = () => {
    if (closed) return;
    closed = true;
    for (const waiter of waiters.splice(0)) waiter({ kind: "eof" });
  };
  reader.on("close", close);
  return {
    next(timeoutMs) {
      if (lines.length > 0) return Promise.resolve({ kind: "line", line: lines.shift() });
      if (closed) return Promise.resolve({ kind: "eof" });
      return new Promise((resolve) => {
        let done = false;
        const waiter = (result) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          resolve(result);
        };
        const timer = setTimeout(() => waiter({ kind: "timeout" }), Math.max(0, timeoutMs));
        timer.unref?.();
        waiters.push(waiter);
      });
    },
    close() {
      reader.close();
      close();
    },
  };
}

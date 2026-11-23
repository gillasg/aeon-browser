#!/usr/bin/env node
// aeon. `aeon repl` takes a lean path (repl-fast.ts) because agents call it once per step; every
// `aeon record` scripted actions likewise (record-fast.ts); every
// other command, and repl's --help, loads the full command line (cli-main.ts).
const argv = process.argv.slice(2);
const help = argv.some((arg) => arg === "--help" || arg === "-h");
if (argv[0] === "repl" && !help) {
  const { runRepl } = await import("./repl-fast.js");
  const { exitAfterFlush } = await import("./exit.js");
  await exitAfterFlush(await runRepl(argv));
} else if (
  argv[0] === "record" &&
  !help &&
  ["start", "stop", "mark", "wait", "run", "terminal"].includes(argv[1] ?? "")
) {
  const { runRecord } = await import("./record-fast.js");
  const { exitAfterFlush } = await import("./exit.js");
  await exitAfterFlush(await runRecord(argv));
} else await import("./cli-main.js");

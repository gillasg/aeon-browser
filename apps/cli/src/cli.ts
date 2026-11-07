#!/usr/bin/env node
// aeon. `aeon repl` takes a lean path (repl-fast.ts) because agents call it once per step; every
// other command, and repl's --help, loads the full command line (cli-main.ts).
const argv = process.argv.slice(2);
const help = argv.some((arg) => arg === "--help" || arg === "-h");
if (argv[0] === "repl" && !help) {
  const { runRepl } = await import("./repl-fast.js");
  process.exit(await runRepl(argv));
} else await import("./cli-main.js");

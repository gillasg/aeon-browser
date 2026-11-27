#!/usr/bin/env node
// graft. `graft repl` takes a lean path (repl-fast.ts) because agents call it once per step; every
// `graft record` scripted actions likewise (record-fast.ts), and `graft call|find|watch|status`
// (site-fast.ts). `--version` reads package.json and nothing else. Every other command, and
// repl's --help, loads the full command line (cli-main.ts).
const argv = process.argv.slice(2);
const help = argv.some((arg) => arg === "--help" || arg === "-h");
const SITE_FAST = new Set(["call", "find", "watch", "status"]);
if (["version", "--version", "-v", "-V"].includes(argv[0] ?? "")) {
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    version?: string;
  };
  process.stdout.write(`graft ${manifest.version ?? "unknown"}\n`);
} else if (argv[0] === "repl" && !help) {
  const { runRepl } = await import("./repl-fast.js");
  const { exitAfterFlush } = await import("./exit.js");
  await exitAfterFlush(await runRepl(argv));
} else if (
  argv[0] === "record" &&
  !help &&
  ["start", "stop", "mark", "wait", "run", "terminal", "ui", "shoot", "assemble"].includes(
    argv[1] ?? "",
  )
) {
  const { runRecord } = await import("./record-fast.js");
  const { exitAfterFlush } = await import("./exit.js");
  await exitAfterFlush(await runRecord(argv));
} else if (SITE_FAST.has(argv[0] ?? "")) {
  const { runSiteFast } = await import("./site-fast.js");
  const { exitAfterFlush } = await import("./exit.js");
  await exitAfterFlush(await runSiteFast(argv));
} else await import("./cli-main.js");

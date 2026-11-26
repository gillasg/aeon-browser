// Runs one lane of tests. The fast lane (default) is every test that does not launch a browser;
// `--browser` runs only those that do. A test is a browser test when its name says e2e or it
// launches Chrome, so a new test lands in the right lane without a list to keep.
// Usage: node scripts/run-tests.mjs [--browser] [--shard=<index>/<total>] <glob>...
import { globSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseShard, selectShard } from "./test-shard.mjs";

let shard;
try {
  shard = parseShard(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}
const browser = process.argv.includes("--browser");
const globs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const launchesBrowser = (file) =>
  /\.e2e\./.test(file) ||
  /browser-fixture-helper|CHROME_PATH|chrome-for-testing/.test(readFileSync(file, "utf8"));
const files = selectShard(
  globs
    .flatMap((pattern) => globSync(pattern))
    .filter((file) => file.endsWith(".test.mjs") && launchesBrowser(file) === browser),
  shard,
);

if (files.length === 0) {
  process.stdout.write(`no ${browser ? "browser" : "fast"} tests matched\n`);
  process.exit(0);
}
const timeout = browser ? 900_000 : 90_000;
// Real-Chrome files run one at a time: a dozen headless Chromes and bridges at once starve each
// other and stall the batch, while every file passes alone.
const concurrency = browser ? ["--test-concurrency=1"] : [];
const run = spawnSync(
  process.execPath,
  ["--test", `--test-timeout=${timeout}`, ...concurrency, ...files],
  {
    stdio: "inherit",
  },
);
process.exit(run.status ?? 1);

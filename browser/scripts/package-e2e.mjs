// The real-Chrome suites that live inside packages (crawl, Site Boosts). They need Chrome for
// Testing (branded Chrome ignores --load-extension): CHROME_PATH, or the copy the repo keeps in
// .slice0-audit. REQUIRE_E2E makes a missing browser a failure instead of a silent skip.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundled = resolve(
  root,
  "../.slice0-audit/chrome-for-testing-154.0.8037.57/chrome-win64/chrome.exe",
);
const chrome = process.env.CHROME_PATH ?? (existsSync(bundled) ? bundled : "");
if (!chrome) {
  process.stderr.write("package e2e: set CHROME_PATH to Chrome for Testing\n");
  process.exit(1);
}
const env = { ...process.env, CHROME_PATH: chrome, REQUIRE_E2E: "1" };
for (const suite of ["packages/crawl", "packages/boosts"]) {
  const run = spawnSync(
    process.execPath,
    ["--test", "--test-timeout=300000", join("test", "e2e.test.mjs")],
    { cwd: join(root, suite), env, stdio: "inherit" },
  );
  if (run.status !== 0) process.exit(run.status ?? 1);
}

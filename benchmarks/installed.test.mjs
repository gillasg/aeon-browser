import assert from "node:assert/strict";
import test from "node:test";
import { parseScenarios, SCENARIOS, summarize, verdict } from "./installed/run.mjs";

// The heavy runner lives in benchmarks/installed/run.mjs (a subdirectory .mjs), so pnpm check only
// runs these pure helpers — selecting scenarios and rendering the report.

test("scenario selection is explicit and order-stable", () => {
  assert.deepEqual(parseScenarios(["--allow-installed", "sleep"]), ["sleep"]);
  assert.deepEqual(parseScenarios(["network", "sleep"]), ["sleep", "network"]);
  assert.deepEqual(parseScenarios(["all"]), SCENARIOS);
  assert.deepEqual(parseScenarios(["--out", "x"]), []);
});

test("the report marks each outcome and keeps the detail", () => {
  const results = [
    { ...verdict("sleep", true, "resumed"), ms: 12 },
    { ...verdict("network", false, "no restart"), ms: 34 },
  ];
  const report = summarize(results);
  assert.match(report, /PASS sleep — resumed \(12 ms\)/);
  assert.match(report, /FAIL network — no restart \(34 ms\)/);
});

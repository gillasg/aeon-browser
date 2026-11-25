import assert from "node:assert/strict";
import test from "node:test";
import { createRng, generateFuzzInputs, STRESS_SCENARIOS, summarizeRun } from "./scenarios.mjs";
import { parseArgs, runStressCli, selectScenarios } from "./run-scenarios.mjs";

test("createRng is deterministic for the same seed", () => {
  const a = createRng(2026);
  const b = createRng(2026);
  const seqA = Array.from({ length: 10 }, () => a());
  const seqB = Array.from({ length: 10 }, () => b());
  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every((n) => n >= 0 && n < 1));
});

test("generateFuzzInputs covers adversarial payloads deterministically", () => {
  const first = generateFuzzInputs(99, 16);
  const second = generateFuzzInputs(99, 16);
  assert.equal(first.length, 16);
  assert.deepEqual(first, second);
  assert.ok(first.some((s) => s.includes("<script>")));
  assert.ok(first.some((s) => s.includes("\u0000")));
  assert.ok(first.some((s) => s.length >= 2048));
});

test("summarizeRun computes pass rate and latency percentiles", () => {
  const summary = summarizeRun([
    { id: "a", ok: true, durationMs: 100 },
    { id: "b", ok: true, durationMs: 250 },
    { id: "c", ok: false, durationMs: 900 },
    { id: "d", ok: true, durationMs: 400 },
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.passed, 3);
  assert.equal(summary.failed, 1);
  assert.equal(summary.passRate, 0.75);
  assert.equal(summary.p50Ms, 250);
  assert.equal(summary.p95Ms, 900);
  assert.equal(summary.ok, false);
});

test("parseArgs and selectScenarios filter stress scenarios", () => {
  const flags = parseArgs(["--dry-run", "--seed=7", "--soak-ms=5000", "--scenarios=tab-churn"]);
  assert.equal(flags.dryRun, true);
  assert.equal(flags.seed, 7);
  assert.equal(flags.soakMs, 5000);
  const selected = selectScenarios(flags.scenarios);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, "tab-churn");
  assert.ok(STRESS_SCENARIOS.every((s) => typeof s.buildCode("http://127.0.0.1/") === "string"));
});

test("runStressCli --dry-run succeeds without Chrome", async () => {
  const report = await runStressCli(["--dry-run", "--seed=42"]);
  assert.equal(report.mode, "dry-run");
  assert.equal(report.summary.ok, true);
  assert.equal(report.scenarios.length, STRESS_SCENARIOS.length);
});

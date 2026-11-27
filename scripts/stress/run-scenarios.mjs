// CLI runner for Graft's real-Chrome stress, soak, chaos, and fuzz scenarios.
// Usage: node scripts/stress/run-scenarios.mjs [--dry-run] [--seed=42] [--soak-ms=0] [--scenarios=a,b]
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { generateFuzzInputs, STRESS_SCENARIOS, summarizeRun } from "./scenarios.mjs";

export function parseArgs(argv) {
  const flags = { dryRun: false, seed: 42, soakMs: 0, scenarios: null };
  for (const arg of argv) {
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg.startsWith("--seed=")) flags.seed = Number(arg.slice(7)) || 42;
    else if (arg.startsWith("--soak-ms=")) flags.soakMs = Math.max(0, Number(arg.slice(10)) || 0);
    else if (arg.startsWith("--scenarios=")) {
      flags.scenarios = arg
        .slice(12)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return flags;
}

export function selectScenarios(names) {
  if (!names || names.length === 0) return STRESS_SCENARIOS;
  const wanted = new Set(names);
  return STRESS_SCENARIOS.filter((s) => wanted.has(s.id));
}

async function startStressSite() {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/burst") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Graft Stress</title><input id='fuzz' type='text'>");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function executeLive(scenarios, flags) {
  const { launchHarness, missingPrerequisite } =
    await import("../../browser/packages/engine/test/conformance/harness.mjs");
  const missing = missingPrerequisite();
  if (missing) throw new Error(`Cannot run live stress harness: ${missing}`);

  const site = await startStressSite();
  const harness = await launchHarness();
  const results = [];
  const deadline = Date.now() + flags.soakMs;
  try {
    let round = 0;
    do {
      for (const scenario of scenarios) {
        const started = Date.now();
        const reply = await harness.run(scenario.buildCode(site.url), `stress-${round}`);
        results.push({
          id: scenario.id,
          round,
          ok: reply.error === undefined,
          durationMs: Date.now() - started,
          error: reply.error,
        });
      }
      round += 1;
    } while (Date.now() < deadline);
  } finally {
    await harness.close();
    await site.close();
  }
  return results;
}

export async function runStressCli(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const scenarios = selectScenarios(flags.scenarios);
  const fuzzSample = generateFuzzInputs(flags.seed, 12);
  if (flags.dryRun) {
    const plan = scenarios.map((s) => ({
      id: s.id,
      category: s.category,
      ok: true,
      durationMs: 0,
    }));
    return {
      mode: "dry-run",
      seed: flags.seed,
      fuzzCount: fuzzSample.length,
      summary: summarizeRun(plan),
      scenarios: plan,
    };
  }
  const results = await executeLive(scenarios, flags);
  return {
    mode: "live",
    seed: flags.seed,
    fuzzCount: fuzzSample.length,
    summary: summarizeRun(results),
    results,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const report = await runStressCli();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.summary.ok) process.exitCode = 1;
}

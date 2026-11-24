// The conformance sweep end to end: one Chrome, the fixture site, every scenario, then the
// verdict against the golden transcripts and the pinned divergences.
//   AEON_CONFORMANCE_ONLY=a,b      run only these scenarios (baseline is kept for leak_canary)
//   AEON_CONFORMANCE_UPDATE=1      rewrite golden/*.json from this run
//   AEON_CONFORMANCE_REQUIRE=chrome  fail instead of skipping when Chrome is missing
//   AEON_CONFORMANCE_OUT=<dir>     write transcripts, per-step results, a log and diff.json
//   AEON_CONFORMANCE_CONCURRENCY=n scenarios at once (3 by default; they share one engine)
//   AEON_CONFORMANCE_TRACE=1       print each cell's duration
import { pathToFileURL } from "node:url";
import { divergences, TESTED_WITH } from "./divergences.mjs";
import { launchHarness, missingPrerequisite } from "./harness.mjs";
import { judge, readGoldens, runScenarios, writeGoldens, writeOutput } from "./run.mjs";
import { scenarios } from "./scenarios.mjs";
import { startSites } from "./sites.mjs";

export function selectScenarios(only = process.env.AEON_CONFORMANCE_ONLY) {
  if (!only) return scenarios;
  const names = new Set(
    only
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  if (names.has("leak_canary")) names.add("baseline");
  const unknown = [...names].filter(
    (name) => !scenarios.some((scenario) => scenario.name === name),
  );
  if (unknown.length) throw new Error(`unknown scenario(s): ${unknown.join(", ")}`);
  return scenarios.filter((scenario) => names.has(scenario.name));
}

/** Why the sweep should skip here (undefined: run it). Throws when Chrome is required. */
export function skipReason() {
  const missing = missingPrerequisite();
  if (missing && process.env.AEON_CONFORMANCE_REQUIRE === "chrome")
    throw new Error(`AEON_CONFORMANCE_REQUIRE=chrome but ${missing}`);
  return missing;
}

export async function runSweep({ log = (line) => process.stdout.write(line + "\n") } = {}) {
  const lines = [];
  const say = (line) => (lines.push(line), log(line));
  const list = selectScenarios();
  const started = Date.now();
  const site = await startSites();
  const harness = await launchHarness();
  say(
    `conformance: ${harness.chromeVersion} (pins tested with ${TESTED_WITH}), launched in ${Date.now() - started} ms`,
  );
  let results;
  try {
    results = await runScenarios(list, harness, site, {
      context: { primary: site.primary, cross: site.cross, files: [harness.home] },
    });
  } finally {
    await harness.close();
    await site.close();
  }
  for (const result of results)
    say(
      `  ${result.scenario}: ${result.transcript.steps.length} steps in ${result.ms} ms${result.crash ? ` CRASH ${result.crash}` : ""}`,
    );
  const update = process.env.AEON_CONFORMANCE_UPDATE === "1";
  if (update) await writeGoldens(results);
  const goldens = await readGoldens(results.map((result) => result.scenario));
  const verdict = judge({
    results,
    goldens,
    divergences: divergences.filter((d) => list.some((s) => s.name === d.scenario)),
  });
  const ms = Date.now() - started;
  say(
    `conformance: ${results.length} scenarios, ${verdict.observed.length} pinned or failing leaves, ${verdict.problems.length} problems, ${ms} ms`,
  );
  for (const problem of verdict.problems) say(`  PROBLEM ${JSON.stringify(problem)}`);
  if (process.env.AEON_CONFORMANCE_OUT)
    await writeOutput(process.env.AEON_CONFORMANCE_OUT, {
      results,
      verdict,
      log: lines,
      meta: { chrome: harness.chromeVersion, ms },
    });
  return { results, verdict, ms };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reason = skipReason();
  if (reason) {
    process.stdout.write(`conformance skipped: ${reason}\n`);
  } else {
    const { verdict } = await runSweep();
    process.exitCode = verdict.problems.length ? 1 : 0;
  }
}

// A save runs the ability's cases before it writes. A new way is tested on its own: if it fails,
// the save throws with the reason and the file on disk keeps the ways it already had.

import type { Ability, AbilityWay } from "./abilities.js";
import { testAbilityCases, type AbilityTest, type AbilityTestReport } from "./ability-contract.js";
import { rowsOf } from "./ability-records.js";
import { wayId } from "./ability-stats.js";

export interface AbilitySample {
  inputs: Record<string, unknown>;
  result: unknown;
}

/** Records one stable fact from the run that produced the ability, unless tests were passed in. */
export function withSample(ability: Ability, sample: AbilitySample | undefined): Ability {
  if (!sample || ability.tests?.length) return ability;
  const expect = stableFact(sample.result);
  if (!expect) return ability;
  return { ...ability, tests: [{ inputs: sample.inputs, expect }] };
}

export async function proveSave(
  candidate: Ability,
  existing: Ability | undefined,
  run: (ability: Ability, inputs: Record<string, unknown>) => Promise<unknown>,
): Promise<AbilityTestReport | undefined> {
  if (candidate.kind === "write") return undefined;
  const tests = candidate.tests ?? [];
  if (!tests.length) return undefined;
  const novel = novelWays(existing?.ways, candidate.ways);
  const probes = novel.length ? novel.map((way) => ({ ...candidate, ways: [way] })) : [candidate];
  return runProbes(candidate, probes, novel.length > 0, run);
}

async function runProbes(
  candidate: Ability,
  probes: Ability[],
  novel: boolean,
  run: (ability: Ability, inputs: Record<string, unknown>) => Promise<unknown>,
): Promise<AbilityTestReport> {
  const cases: AbilityTestReport["cases"] = [];
  let constant = false;
  for (const probe of probes) {
    const report = await testAbilityCases(probe, (inputs) => run(probe, inputs));
    if (!report.ok) throw failed(candidate, probe, novel, report);
    cases.push(...report.cases);
    constant = constant || report.constant;
  }
  return { ok: true, cases, constant };
}

function failed(
  candidate: Ability,
  probe: Ability,
  novel: boolean,
  report: AbilityTestReport,
): Error {
  const item = report.cases.find((entry) => !entry.ok);
  const kind = probe.ways[0]?.kind ?? "way";
  const label = novel ? `new ${kind} way` : `${kind} way`;
  return new Error(
    `ABILITY_TEST_FAILED: ${candidate.name} ${label} failed its test (${reason(item, report)})`,
  );
}

function reason(
  item: AbilityTestReport["cases"][number] | undefined,
  report: AbilityTestReport,
): string {
  if (item?.error) return item.error;
  if (item?.missing?.length) return `missing ${item.missing.join(", ")}`;
  if (report.constant) return "constant output: the result ignores its inputs";
  return "failed";
}

function novelWays(existing: AbilityWay[] | undefined, next: AbilityWay[]): AbilityWay[] {
  const known = new Set((existing ?? []).map((way) => wayId(way)));
  return next.filter((way) => !known.has(wayId(way)));
}

function stableFact(result: unknown): AbilityTest["expect"] {
  const rows = rowsOf(result);
  const source = rows ? rows[0] : result;
  if (typeof source === "string" && source.length > 0 && source.length <= 80)
    return { value: source };
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  return firstFact(source as Record<string, unknown>);
}

function firstFact(record: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.length > 0 && value.length <= 80)
      return { [key]: value };
    if (typeof value === "number" || typeof value === "boolean") return { [key]: value };
  }
  return undefined;
}

// A save runs the ability's cases before it writes. A new way is tested on its own: if it fails,
// the save throws with the reason and the file on disk keeps the ways it already had.

import type { Ability, AbilityWay } from "./abilities.js";
import { wayDigest } from "./ability-digest.js";
import { testAbilityCases, type AbilityTest, type AbilityTestReport } from "./ability-contract.js";
import { rowsOf } from "./ability-records.js";
import { wayId } from "./ability-stats.js";

export interface AbilitySample {
  inputs: Record<string, unknown>;
  /** The answer, when the run recorded one. */
  result?: unknown;
  /** What makes this sample different, e.g. "another region", "an empty listing". */
  purpose?: string;
}

/**
 * Records one case per differing public sample, capped at eight, each with its purpose, so an
 * ability that works on one store, region or template is caught on another at build time. Tests
 * passed in by the caller always win.
 */
export function withSamples(
  ability: Ability,
  sample: AbilitySample | undefined,
  samples: readonly AbilitySample[] = [],
): Ability {
  if (ability.tests?.length) return ability;
  const pool = [sample, ...samples].filter((item): item is AbilitySample => Boolean(item));
  if (!pool.length) return ability;
  const first = pool[0] as AbilitySample;
  const tests: AbilityTest[] = [];
  const seen = new Set<string>();
  for (const item of pool.slice(0, 8)) {
    const key = JSON.stringify(item.inputs);
    if (seen.has(key)) continue;
    seen.add(key);
    const expect = stableFact(item.result);
    if (!expect) continue;
    // One sample keeps the old single-case shape; a varied set names why each case is kept.
    const purpose = pool.length > 1 ? (item.purpose ?? purposeOf(item, first)) : item.purpose;
    tests.push({ inputs: item.inputs, expect, ...(purpose ? { purpose } : {}) });
  }
  return tests.length ? { ...ability, tests } : ability;
}

function purposeOf(item: AbilitySample, first: AbilitySample): string | undefined {
  if (item === first) return "the run that produced the ability";
  const changed = Object.keys(item.inputs).filter(
    (key) => JSON.stringify(item.inputs[key]) !== JSON.stringify(first.inputs[key]),
  );
  return changed.length ? `different ${changed.join(", ")}` : undefined;
}

/** Records one stable fact from the run that produced the ability, unless tests were passed in. */
export function withSample(ability: Ability, sample: AbilitySample | undefined): Ability {
  return withSamples(ability, sample);
}

/** The result of one probe, with the way that answered it (its checked test record). */
export interface ProbeResult {
  result: unknown;
  way?: string;
}

export async function proveSave(
  candidate: Ability,
  existing: Ability | undefined,
  run: (ability: Ability, inputs: Record<string, unknown>) => Promise<ProbeResult>,
): Promise<AbilityTestReport | undefined> {
  // Kind is already classified, so a read that contained an explicit write is not probed.
  if (candidate.kind === "write") return undefined;
  const tests = candidate.tests ?? [];
  if (!tests.length) return undefined;
  const untested = untestedWays(existing, candidate);
  if (!untested.length) return { ok: true, cases: [], constant: false, skipped: true, ways: [] };
  const novel = new Set(novelWays(existing?.ways, candidate.ways).map(wayId));
  const probes = untested.map((way) => ({ ...candidate, ways: [way] }));
  return runProbes(candidate, probes, novel, run);
}

/** Ways with no passing test record at this exact content (tests and outputs included). */
function untestedWays(existing: Ability | undefined, candidate: Ability): AbilityWay[] {
  return candidate.ways.filter((way) => existing?.tested?.[wayDigest(candidate, way)]?.ok !== true);
}

async function runProbes(
  candidate: Ability,
  probes: Ability[],
  novel: Set<string>,
  run: (ability: Ability, inputs: Record<string, unknown>) => Promise<ProbeResult>,
): Promise<AbilityTestReport> {
  const cases: AbilityTestReport["cases"] = [];
  const proven = new Set<string>();
  let constant = false;
  for (const probe of probes) {
    const ran: (string | undefined)[] = [];
    const report = await testAbilityCases(probe, async (inputs) => {
      try {
        const out = await run(probe, inputs);
        ran.push(out.way);
        return out.result;
      } catch (error) {
        ran.push(undefined);
        throw error;
      }
    });
    const way = probe.ways[0];
    if (!report.ok) throw failed(candidate, probe, way ? novel.has(wayId(way)) : false, report);
    report.cases.forEach((item, index) => {
      if (item.ok && way) proven.add(ran[index] ?? wayId(way));
    });
    cases.push(...report.cases);
    constant = constant || report.constant;
  }
  return { ok: true, cases, constant, ways: [...proven] };
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

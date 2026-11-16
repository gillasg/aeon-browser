// Content digests for abilities. A version is a digest of what the ability does, not of when it
// was written: stats, timestamps and stored test records are left out, so a run's stats update or
// a test result never looks like a new version. The way digest adds the tests and the output
// contract, so a test result applies only to the exact way content it was run against.

import { createHash } from "node:crypto";
import type { Ability, AbilityWay } from "./abilities.js";
import { wayId } from "./ability-stats.js";

/** What a stored test run covered: the way at this digest, when, and whether it passed. */
export interface AbilityTested {
  digest: string;
  at: string;
  ok: boolean;
}
/** Everything that changes how the ability behaves. `stats`, `tested` and the timestamps do not. */
export function abilityContent(ability: Ability): Record<string, unknown> {
  return {
    name: ability.name,
    site: ability.site,
    description: ability.description,
    kind: ability.kind,
    inputs: ability.inputs,
    outputs: ability.outputs,
    ways: ability.ways,
    tests: ability.tests,
    preconditions: ability.preconditions,
    postcondition: ability.postcondition,
    options: ability.options,
    writes: ability.writes,
    createdBy: ability.createdBy,
    sourceKind: ability.sourceKind,
    promoted: ability.promoted,
  };
}

/** A digest of the ability's content; equal digests mean nothing a caller sees has changed. */
export function contentDigest(ability: Ability): string {
  return digestOf(abilityContent(ability));
}

/** A digest of one way, with the tests and the output contract its result must satisfy. */
export function wayDigest(ability: Ability, way: AbilityWay): string {
  return digestOf({
    kind: ability.kind,
    outputs: ability.outputs,
    tests: ability.tests,
    way: normalizedWay(way),
  });
}

/** Ways with no passing test for their current content. A changed way is untested again. */
export function untestedWays(ability: Ability): AbilityWay[] {
  if (!ability.tests?.length || ability.kind === "write") return [];
  return ability.ways.filter((way) => ability.tested?.[wayDigest(ability, way)]?.ok !== true);
}

/** Stamps the ways that ran (all when no ids are given) as tested now, with the outcome. */
export function testedAbility(
  ability: Ability,
  ok: boolean,
  at = new Date().toISOString(),
  ways?: string[],
): Ability {
  const ran = ways ? new Set(ways) : undefined;
  const tested: Record<string, AbilityTested> = {};
  for (const way of ability.ways) {
    if (ran && !ran.has(wayId(way))) continue;
    const digest = wayDigest(ability, way);
    tested[digest] = { digest, at, ok };
  }
  return { ...ability, tested };
}

/**
 * The ability with test records for its current content: `proven` names the ways this save
 * actually ran and passed, so only those are stamped, and every other way keeps a matching
 * earlier record (or stays untested). Stats and test records alone never mark a way tested.
 */
export function withTested(
  ability: Ability,
  previous: Ability | undefined,
  proven: string[] | undefined,
): Ability {
  const ran = new Set(proven ?? []);
  const at = new Date().toISOString();
  const tested: Record<string, AbilityTested> = {};
  for (const way of ability.ways) {
    const digest = wayDigest(ability, way);
    if (ran.has(wayId(way))) {
      tested[digest] = { digest, at, ok: true };
      continue;
    }
    const entry = ability.tested?.[digest] ?? previous?.tested?.[digest];
    if (entry?.digest === digest) tested[digest] = entry;
  }
  const next: Ability = { ...ability };
  if (Object.keys(tested).length) next.tested = tested;
  else delete next.tested;
  return next;
}

export function digestOf(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16);
}

/** A script's comments and formatting are not behaviour; everything else is compared as written. */
function normalizedWay(way: AbilityWay): AbilityWay {
  if (way.kind !== "script") return way;
  return { ...way, code: normalizedCode(way.code) };
}

/** Code with comments gone and runs of white space outside strings reduced to one space. */
export function normalizedCode(code: string): string {
  const out: string[] = [];
  let index = 0;
  while (index < code.length) {
    const char = code[index] ?? "";
    if (char === '"' || char === "'" || char === "`") {
      const end = quotedEnd(code, index);
      out.push(code.slice(index, end));
      index = end;
      continue;
    }
    index = nextToken(code, index, out);
  }
  return out.join("").trim();
}

/** One non-string character, or the start of a comment, appended to `out`. */
function nextToken(code: string, index: number, out: string[]): number {
  const char = code[index] ?? "";
  if (char === "/" && code[index + 1] === "/") return skipLine(code, index, out);
  if (char === "/" && code[index + 1] === "*") return skipBlock(code, index, out);
  if (/\s/.test(char)) {
    if (out.at(-1) !== " ") out.push(" ");
    return index + 1;
  }
  out.push(char);
  return index + 1;
}

function quotedEnd(code: string, from: number): number {
  const quote = code[from];
  for (let index = from + 1; index < code.length; index++) {
    const char = code[index];
    if (char === "\\") index++;
    else if (char === quote) return index + 1;
  }
  return code.length;
}

function skipLine(code: string, from: number, out: string[]): number {
  let index = from;
  while (index < code.length && code[index] !== "\n") index++;
  out.push(" ");
  return index;
}

function skipBlock(code: string, from: number, out: string[]): number {
  for (let index = from + 2; index < code.length - 1; index++)
    if (code[index] === "*" && code[index + 1] === "/") {
      out.push(" ");
      return index + 2;
    }
  return code.length;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") return stableObject(value as Record<string, unknown>);
  return JSON.stringify(value) ?? "null";
}

function stableObject(record: Record<string, unknown>): string {
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

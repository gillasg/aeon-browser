// Content digests for abilities. A version is a digest of what the ability does, not of when it
// was written: stats, timestamps and stored test records are left out, so a run's stats update or
// a test result never looks like a new version. The way digest adds the tests and the output
// contract, so a test result applies only to the exact way content it was run against.

import { createHash } from "node:crypto";
import type { Ability, AbilityWay } from "./abilities.js";

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

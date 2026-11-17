// Checks derived when an ability is saved, then run on every read. An empty list or a null where
// the saved answer had data is a failed way (the next way is tried), not a success. A matches
// pattern is refused when it is too long, invalid, or matches a stored secret. Each run bounds
// matches: pattern ≤500 characters, 100 ms in a vm, the first 64 KB, 1 s for the run, ≤50 checks.

import { boundedTest, validatePattern, type RegexBudget } from "./bounded-regex.js";
import type { Ability, AbilityWay } from "./abilities.js";
import type { AbilitySample } from "./ability-save-test.js";
import { getPointer } from "./infer/schema.js";
import { createRedactor, SECRET_KEYS } from "./redact.js";

export interface AbilityAssert {
  /** JSON pointer. `/*` means every element of the array at the prefix. */
  path: string;
  op: "array_min_len" | "not_null" | "matches";
  value?: number | string;
}

const LIST_KEYS = ["items", "records", "results", "data"];
const ASSERT_LIMIT = 50;
const BUDGET_MS = 1000;
const CREDENTIAL = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/;
const FORMATS: RegExp[] = [
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^(https?|wss?):\/\/[^\s]+$/i,
  /^-?[$€£]?\d{1,12}(\.\d{1,8})?$/,
];

type Budget = RegexBudget;

/** Stores checks from the saved answer. Caller-supplied checks are kept, minus refused patterns. */
export function withResultAsserts(ability: Ability, sample: AbilitySample | undefined): Ability {
  if (ability.kind === "write") return ability;
  const secrets = secretsIn(sample?.result, secretsIn(ability));
  const given = ability.options.asserts;
  const asserts = Array.isArray(given)
    ? keptAsserts(given, secrets)
    : deriveResultAsserts(sample?.result, secrets);
  if (!asserts.length) return withoutAsserts(ability, given);
  return { ...ability, options: { ...ability.options, asserts } };
}

function withoutAsserts(ability: Ability, given: unknown): Ability {
  if (!Array.isArray(given)) return ability;
  const options = { ...ability.options };
  delete options.asserts;
  return { ...ability, options };
}

/** Why this answer fails the saved checks, including the next step, or undefined when it passes. */
export function resultMismatch(
  ability: Ability,
  way: AbilityWay,
  result: unknown,
): string | undefined {
  const asserts = keptAsserts(ability.options.asserts, []);
  if (!asserts.length) return undefined;
  const budget: Budget = { remainingMs: BUDGET_MS };
  for (const check of asserts) {
    const why = failOf(check, result, budget);
    if (why) return `${why} ${nextStep(ability, way)}`;
  }
  return undefined;
}

export function deriveResultAsserts(result: unknown, secrets: string[]): AbilityAssert[] {
  const found: AbilityAssert[] = [];
  collect(result, "", found);
  return keptAsserts(found, secrets);
}

function collect(value: unknown, path: string, out: AbilityAssert[]): void {
  if (out.length >= ASSERT_LIMIT) return;
  if (Array.isArray(value)) {
    fromArray(value, path, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const listKey = LIST_KEYS.find((key) => Array.isArray(record[key]) && record[key].length > 0);
  if (listKey) {
    fromArray(record[listKey] as unknown[], `${path}/${escapePointer(listKey)}`, out);
    return;
  }
  for (const [key, item] of Object.entries(record)) collectField(item, path, key, out);
}

function collectField(item: unknown, path: string, key: string, out: AbilityAssert[]): void {
  if (out.length >= ASSERT_LIMIT || item === null || item === undefined) return;
  const child = `${path}/${escapePointer(key)}`;
  if (Array.isArray(item)) {
    fromArray(item, child, out);
    return;
  }
  if (typeof item === "object") {
    out.push({ path: child, op: "not_null" });
    collect(item, child, out);
    return;
  }
  out.push({ path: child, op: "not_null" });
  if (typeof item === "string") addMatch(child, [item], out);
}

function fromArray(value: unknown[], path: string, out: AbilityAssert[]): void {
  if (!value.length || out.length >= ASSERT_LIMIT) return;
  out.push({ path, op: "array_min_len", value: 1 });
  const objects = value.filter(isRecord);
  if (objects.length !== value.length) return;
  for (const key of Object.keys(objects[0] ?? {})) addItemField(objects, path, key, out);
}

function addItemField(
  objects: Record<string, unknown>[],
  path: string,
  key: string,
  out: AbilityAssert[],
): void {
  if (out.length >= ASSERT_LIMIT) return;
  if (!objects.every((item) => item[key] !== null && item[key] !== undefined)) return;
  const child = `${path}/*/${escapePointer(key)}`;
  const samples = objects.map((item) => item[key]);
  if (samples.every(isScalar)) {
    out.push({ path: child, op: "not_null" });
    const strings = samples.filter((item): item is string => typeof item === "string");
    if (strings.length === samples.length) addMatch(child, strings, out);
    return;
  }
  const nested = samples.filter(isRecord);
  if (nested.length !== samples.length) return;
  out.push({ path: child, op: "not_null" });
  for (const name of Object.keys(nested[0] ?? {})) addItemField(nested, child, name, out);
}

function addMatch(path: string, values: string[], out: AbilityAssert[]): void {
  if (out.length >= ASSERT_LIMIT) return;
  const format = FORMATS.find((pattern) => values.every((value) => pattern.test(value)));
  if (format) out.push({ path, op: "matches", value: format.source });
}

function keptAsserts(asserts: unknown, secrets: string[]): AbilityAssert[] {
  if (!Array.isArray(asserts)) return [];
  const budget: Budget = { remainingMs: BUDGET_MS };
  const kept: AbilityAssert[] = [];
  for (const item of asserts) {
    if (kept.length >= ASSERT_LIMIT) break;
    const next = oneAssert(item, secrets, budget);
    if (next) kept.push(next);
  }
  return kept;
}

function oneAssert(item: unknown, secrets: string[], budget: Budget): AbilityAssert | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const check = item as AbilityAssert;
  if (typeof check.path !== "string" || !knownOp(check.op)) return undefined;
  if (check.op === "array_min_len") return lengthAssert(check);
  if (check.op === "not_null") return { path: check.path, op: "not_null" };
  return matchAssert(check, secrets, budget);
}

function lengthAssert(check: AbilityAssert): AbilityAssert | undefined {
  if (typeof check.value !== "number" || !Number.isInteger(check.value) || check.value < 0)
    return undefined;
  return { path: check.path, op: "array_min_len", value: check.value };
}

function matchAssert(
  check: AbilityAssert,
  secrets: string[],
  budget: Budget,
): AbilityAssert | undefined {
  if (typeof check.value !== "string") return undefined;
  try {
    validatePattern(check.value, { label: "matches" });
  } catch {
    return undefined;
  }
  if (secrets.some((secret) => patternHits(check.value as string, secret, budget)))
    return undefined;
  return { path: check.path, op: "matches", value: check.value };
}

function failOf(check: AbilityAssert, result: unknown, budget: Budget): string | undefined {
  if (check.op === "array_min_len") return lengthFail(check, result);
  if (check.op === "not_null") return nullFail(check, result);
  return matchFail(check, result, budget);
}

function lengthFail(check: AbilityAssert, result: unknown): string | undefined {
  const found = getPointer(result, check.path);
  const least = typeof check.value === "number" ? check.value : 1;
  if (Array.isArray(found) && found.length >= least) return undefined;
  const where = check.path || "/";
  const why = Array.isArray(found) ? "was empty" : "was missing";
  return `RESULT_MISMATCH: ${where} ${why}; the saved answer had rows`;
}

function nullFail(check: AbilityAssert, result: unknown): string | undefined {
  const missing = valuesAt(result, check.path).some(
    (value) => value === null || value === undefined,
  );
  if (!missing) return undefined;
  return `RESULT_MISMATCH: ${check.path} was null; the saved answer had a value`;
}

function matchFail(check: AbilityAssert, result: unknown, budget: Budget): string | undefined {
  const pattern = typeof check.value === "string" ? check.value : "";
  for (const value of valuesAt(result, check.path)) {
    if (typeof value !== "string")
      return `RESULT_MISMATCH: ${check.path} was not text; the saved answer matched ${pattern}`;
    const why = matchWhy(pattern, value, budget);
    if (why) return `RESULT_MISMATCH: ${check.path} ${why}`;
  }
  return undefined;
}

function matchWhy(pattern: string, value: string, budget: Budget): string | undefined {
  try {
    if (boundedMatch(pattern, value, budget)) return undefined;
    return `did not match ${pattern}; the saved answer matched it`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message;
  }
}

function valuesAt(result: unknown, path: string): unknown[] {
  const star = path.indexOf("/*");
  if (star < 0) return [getPointer(result, path)];
  const array = getPointer(result, path.slice(0, star));
  if (!Array.isArray(array)) return [undefined];
  const rest = path.slice(star + 2);
  if (!rest) return array;
  return array.map((item) => getPointer(item, rest));
}

function boundedMatch(pattern: string, text: string, budget: Budget): boolean {
  return boundedTest(pattern, text, { label: "matches", budget });
}

function patternHits(pattern: string, secret: string, budget: Budget): boolean {
  try {
    return boundedMatch(pattern, secret, budget);
  } catch {
    return true;
  }
}

function nextStep(ability: Ability, way: AbilityWay): string {
  const other = ability.ways.find((item) => item.kind !== way.kind);
  if (!other)
    return "Next: read the page and saveAbility again from a result that still has the data";
  return `Next: site.run(${JSON.stringify(ability.name)}, inputs, {via: ${JSON.stringify(other.kind)}})`;
}

function secretsIn(value: unknown, found: string[] = []): string[] {
  const redactor = createRedactor();
  walkSecrets(value, found, redactor, undefined);
  return found;
}

function walkSecrets(
  value: unknown,
  found: string[],
  redactor: ReturnType<typeof createRedactor>,
  key: string | undefined,
): void {
  if (typeof value === "string") {
    if ((key && SECRET_KEYS.test(key)) || CREDENTIAL.test(value) || redactor.text(value) !== value)
      found.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkSecrets(item, found, redactor, undefined);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [name, item] of Object.entries(value)) walkSecrets(item, found, redactor, name);
}

function knownOp(op: unknown): op is AbilityAssert["op"] {
  return op === "array_min_len" || op === "not_null" || op === "matches";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

function escapePointer(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

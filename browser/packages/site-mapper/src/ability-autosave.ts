// A successful browser_code run becomes a saved ability without a prompt. The parts of the request
// that change between runs (months, dates, years, search terms and ids the caller named) become
// caller inputs; secrets and personal values are left out so the normal save scrub can never store
// them. One-off and failed runs are skipped, and an ability that already covers the task is updated
// in place instead of duplicating. Nothing here opens a tab or asks the user: the caller decides
// when to persist, and every write still goes through saveAbility's receipts and safe-write rules.

import type { Ability, AbilityWayScript } from "./abilities.js";
import { listAbilities, saveAbility } from "./abilities.js";
import { siteName } from "./registry.js";

/** One finished browser_code run, as far as auto-saving needs it. */
export interface AutoSaveRun {
  /** The site the script drove. */
  site: string;
  /** The user's request that led to the run. */
  request: string;
  /** The browser_code that completed the task. */
  code: string;
  /** The final answer, when one was recorded (kept as the ability's first test). */
  result?: unknown;
  /** Values the request named, by input name. */
  inputs?: Record<string, unknown>;
  /** Values typed into the page during the run. */
  typed?: { field?: string; value: string }[];
  /** False when the run ended in an error. */
  ok: boolean;
  /** True when the user corrected or redirected the run. */
  corrected?: boolean;
  /** True for runs that only make sense once. */
  oneOff?: boolean;
  at?: string;
}

/** Why a run is not worth saving. Absent means it qualifies. */
export function autoSaveBlocker(run: AutoSaveRun): string | undefined {
  if (!run.ok) return "the run did not finish successfully";
  if (run.corrected) return "the user corrected the run";
  if (run.oneOff) return "the run was a one-off";
  if (!siteName(run.site)) return "there is no site";
  if (!run.code || !run.code.trim()) return "there is no browser_code to save";
  if (!run.request || !run.request.trim()) return "there is no request to learn from";
  return undefined;
}

/** A literal from the request that should become a caller input. */
export interface VaryingValue {
  name: string;
  example: string;
  from: "request" | "typed";
}

export interface InferredScript {
  /** The script with varying literals replaced by `inputs.<name>` reads. */
  code: string;
  inputs: VaryingValue[];
  /** JSON Schema properties for the new inputs. */
  properties: Record<string, Record<string, unknown>>;
}

const MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|oct|sept|sep|nov|dec";
const CANDIDATES: { name: string; pattern: RegExp }[] = [
  { name: "date", pattern: /\b\d{4}-\d{2}-\d{2}\b/g },
  { name: "month", pattern: new RegExp(`\\b(?:${MONTHS})\\b`, "gi") },
  { name: "year", pattern: /\b(?:19|20)\d{2}\b/g },
];

/** Values that must never become stored examples: credentials and personal identifiers. */
const PRIVATE = /@|(?:\+?\d[\d\s-]{7,}\d)|^[A-Za-z0-9+/=_-]{24,}$/;

function camelName(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words
    .map((word, index) => (index ? word[0]?.toUpperCase() + word.slice(1) : word))
    .join("")
    .slice(0, 32);
}

// A string literal in the script: group 1 is the quote, group 2 its content. A bare token could be
// part of an identifier or a call the script needs, so only literals are ever rewritten.
const STRING_LITERAL = /(["'])((?:\\.|(?!\1)[^\\])*)\1/g;

function hasLiteral(code: string, value: string): boolean {
  return [...code.matchAll(STRING_LITERAL)].some((match) => (match[2] ?? "").includes(value));
}

/**
 * Rewrites a literal that holds a varying value into a template literal that reads the caller
 * input at run time. Script ways are handed an `inputs` object, so an embedded `{{input}}` string
 * would be stored literally and replay the example; `${inputs.x}` actually varies per call.
 */
function templateLiterals(code: string, value: string, name: string): string {
  return code.replace(STRING_LITERAL, (whole, quote: string, text: string) => {
    if (!text.includes(value) || text.includes("`") || text.includes("${")) return whole;
    return "`" + text.split(value).join(`\${inputs.${name}}`) + "`";
  });
}

/**
 * Turns the changing parts of a request into caller inputs. Only values that also appear as a
 * string literal in the script are templated: a date the user said in the request but the script
 * never used is not an input. A value that looks like a credential or a personal id is dropped.
 */
export function inferScriptInputs(
  request: string,
  code: string,
  typed: { field?: string; value: string }[] = [],
): InferredScript {
  const found = collectValues(request, code, typed);
  const properties: Record<string, Record<string, unknown>> = {};
  let next = code;
  for (const value of found.values()) {
    let name = value.name;
    for (let index = 2; properties[name]; index++) name = `${value.name}${index}`;
    value.name = name;
    properties[name] = { type: "string", example: value.example, "x-from": value.from };
    next = templateLiterals(next, value.example, name);
  }
  return { code: next, inputs: [...found.values()], properties };
}

function collectValues(
  request: string,
  code: string,
  typed: { field?: string; value: string }[],
): Map<string, VaryingValue> {
  const found = new Map<string, VaryingValue>();
  const add = (example: string, wanted: string, from: VaryingValue["from"]) => {
    if (example.length < 3 || PRIVATE.test(example) || found.has(example)) return;
    if (!hasLiteral(code, example)) return;
    found.set(example, { name: camelName(wanted) || "value", example, from });
  };
  for (const { name, pattern } of CANDIDATES) {
    for (const match of request.matchAll(new RegExp(pattern.source, pattern.flags)))
      if (match[0]) add(match[0], name, "request");
  }
  // Quoted terms in the request that the script also used are likely to change next time.
  for (const match of request.matchAll(/"([^"]{3,40})"|'([^']{3,40})'/g))
    add(match[1] ?? match[2] ?? "", match[1] ?? match[2] ?? "", "request");
  for (const item of typed) if (item.value) add(item.value, item.field ?? item.value, "typed");
  return found;
}

/** A short, stable ability name from the request and site, e.g. "receipts-by-month". */
export function abilityNameFor(request: string): string {
  const words = request
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word))
    .slice(0, 3);
  return words.join("-") || "saved-task";
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "my",
  "me",
  "please",
  "get",
  "give",
  "show",
  "find",
  "download",
  "fetch",
  "check",
  "for",
  "of",
  "to",
  "on",
  "with",
  "and",
  "from",
]);

/** Builds the draft ability from a finished run, before dedup and save. */
export function buildAutoAbility(run: AutoSaveRun): Ability {
  const inferred = inferScriptInputs(run.request, run.code, run.typed);
  const now = run.at ?? new Date().toISOString();
  const code = `async (page, bu, inputs) => {\n${indent(inferred.code)}\n}`;
  const way: AbilityWayScript = { kind: "script", runtime: "page", code };
  const inputs: Record<string, unknown> = {
    type: "object",
    properties: inferred.properties,
  };
  const ability: Ability = {
    name: abilityNameFor(run.request),
    site: siteName(run.site),
    description: `Learned from: ${run.request}`,
    kind: "read",
    inputs,
    ways: [way],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
  };
  return ability;
}

function indent(code: string): string {
  return code
    .split("\n")
    .map((line) => (line.trim() ? `  ${line}` : line))
    .join("\n");
}

/**
 * True when an existing ability already covers this task: same site and the same script content,
 * ignoring the name. An exact-match draft replaces that ability's content rather than adding a
 * second copy, while the ordinary save version history keeps the earlier one restorable.
 */
export function findDuplicate(abilities: readonly Ability[], draft: Ability): Ability | undefined {
  const first = draft.ways[0];
  if (!first || first.kind !== "script") return undefined;
  const code = first.code.trim();
  return abilities.find(
    (ability) =>
      ability.site === draft.site &&
      ability.ways.some(
        (way) => way.kind === "script" && way.runtime === first.runtime && way.code.trim() === code,
      ),
  );
}

export interface AutoSaveOutcome {
  status: "saved" | "updated" | "skipped";
  reason?: string;
  ability?: Ability;
  /** The one short line the run card may show when its UI already has that slot. */
  line?: string;
}

export interface AutoSaveDeps {
  /** Abilities already on the site, for dedup. */
  existing?: readonly Ability[];
  /** Passed straight to saveAbility so a read can be tested with a host. */
  saveOptions?: Parameters<typeof saveAbility>[1];
}

/**
 * Saves a finished run quietly. Reuses saveAbility, so inference, scrubbing, the caller contract,
 * write receipts and version history all behave exactly as on an explicit save.
 */
export async function autoSaveAbility(
  run: AutoSaveRun,
  deps: AutoSaveDeps = {},
): Promise<AutoSaveOutcome> {
  const blocker = autoSaveBlocker(run);
  if (blocker) return { status: "skipped", reason: blocker };
  const draft = buildAutoAbility(run);
  const existing = deps.existing ?? (await listAbilities(draft.site).catch(() => [] as Ability[]));
  const duplicate = findDuplicate(existing, draft);
  const target = duplicate ? { ...draft, name: duplicate.name } : draft;
  const saved = await saveAbility(target, {
    replace: true,
    ...(run.result !== undefined
      ? { sample: { inputs: run.inputs ?? {}, result: run.result } }
      : {}),
    ...deps.saveOptions,
  });
  const line = `Learned: ${saved.ability.name} [Rename] [Forget]`;
  return {
    status: duplicate ? "updated" : "saved",
    ability: saved.ability,
    line,
  };
}

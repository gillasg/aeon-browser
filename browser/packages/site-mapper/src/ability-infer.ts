// What the run that saved an ability tells us about its inputs: a value typed into the page, a
// value the prompt named, a value the page's URL carried — and a value a later request took from
// an earlier answer. Candidates become inputs with an example and an `x-from` note, or a
// `{{steps.<i>.<path>}}` reference, so the saved ability is not hardcoded to the example.
// Values under three characters are never rewritten; they are too ambiguous to template.

import type {
  Ability,
  AbilityApiStep,
  AbilityReference,
  AbilityWay,
  AbilityWayApi,
} from "./abilities.js";
import { leaves } from "./infer/schema.js";

/** A value typed into the page during the run, with the field it went into. */
export interface AbilityTypedValue {
  field?: string;
  value: string;
}

/** The run that produced an ability, as far as inference needs it. */
export interface AbilityDemonstration {
  /** Values the run was given, by input name. */
  inputs?: Record<string, unknown>;
  /** Values typed into the page. */
  typed?: AbilityTypedValue[];
  /** What each api step answered, in order. */
  responses?: unknown[];
  /** The final result, when the run recorded one. */
  result?: unknown;
}

export interface InferredAbility {
  ability: Ability;
  /** New inputs, by name. */
  inputs: string[];
  /** Param values rewritten as `steps.<i>.<path>`, by way. */
  references: string[];
}

interface Context {
  properties: Record<string, Record<string, unknown>>;
  demonstrated: Map<string, string>;
  typed: Map<string, string | undefined>;
  responses: unknown[];
  added: string[];
  refs: AbilityReference[];
}

const TYPED_KINDS = new Set(["fill", "type", "select", "choose", "setValue", "setvalue", "upload"]);
const SECRET_FIELD = /password|passcode|secret|token|otp|cvv|cvc|security code|card number/i;

/** A value that looks minted or private: still an input, but its example is not stored. */
function looksSecretValue(value: string): boolean {
  return /^[A-Za-z0-9+/=_-]{24,}$/.test(value);
}

export function inferAbilityInputs(
  ability: Ability,
  demonstration: AbilityDemonstration = {},
): InferredAbility {
  const context = contextOf(ability, demonstration);
  const ways = ability.ways.map((way) => inferWay(way, context));
  const references = context.refs.map((ref) => ref.from);
  const inferred =
    context.added.length || references.length
      ? { at: new Date().toISOString(), inputs: context.added, references }
      : ability.inferred;
  const baseInputs = ability.inputs as Record<string, unknown>;
  const inputs =
    baseInputs.properties && typeof baseInputs.properties === "object"
      ? { ...baseInputs, properties: context.properties }
      : { type: "object", properties: context.properties };
  return {
    ability: { ...ability, inputs, ways, ...(inferred ? { inferred } : {}) },
    inputs: context.added,
    references,
  };
}

function contextOf(ability: Ability, demonstration: AbilityDemonstration): Context {
  const properties = structuredClone(
    ((ability.inputs as { properties?: Record<string, Record<string, unknown>> }).properties ??
      {}) as Record<string, Record<string, unknown>>,
  );
  const inputValues = demonstration.inputs ?? {};
  const demonstrated = new Map<string, string>();
  for (const [name, value] of Object.entries(inputValues)) {
    if (!isScalar(value)) continue;
    demonstrated.set(String(value), name);
    if (!properties[name] || properties[name].example !== undefined) continue;
    if (looksSecretValue(String(value))) continue;
    properties[name] = { ...properties[name], example: value, "x-from": "run" };
  }
  const typed = new Map<string, string | undefined>();
  for (const item of demonstration.typed ?? []) if (item.value) typed.set(item.value, item.field);
  return {
    properties,
    demonstrated,
    typed,
    responses: demonstration.responses ?? [],
    added: [],
    refs: [],
  };
}

function inferWay(way: AbilityWay, context: Context): AbilityWay {
  if (way.kind === "api") return inferApiWay(way, context);
  if (way.kind === "steps") return { ...way, steps: inferSteps(way.steps, context) };
  if (way.kind === "page" && way.url) return { ...way, url: queryUrl(way.url, context) ?? way.url };
  return way;
}

function inferApiWay(way: AbilityWayApi, context: Context): AbilityWayApi {
  const start = context.refs.length;
  const operations = way.operations?.map((step, index) => ({
    ...step,
    ...(step.params ? { params: paramsOf(step, index, context) } : {}),
  }));
  const params = way.params
    ? paramsOf({ operation: way.operation ?? "", params: way.params }, undefined, context)
    : way.params;
  const open = way.open ? (queryUrl(way.open, context) ?? way.open) : way.open;
  const refs = context.refs.slice(start);
  return {
    ...way,
    ...(params ? { params } : {}),
    ...(operations ? { operations } : {}),
    ...(open !== way.open ? { open } : {}),
    ...(refs.length ? { refs } : {}),
  };
}

function paramsOf(
  step: AbilityApiStep,
  index: number | undefined,
  context: Context,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(step.params ?? {}).map(([key, value]) => {
      const next = scalarOf(value, index, key, context);
      return [key, next === undefined ? value : next];
    }),
  );
}

/** One literal param value: a reference to an earlier answer, an input, or unchanged. */
function scalarOf(
  value: unknown,
  index: number | undefined,
  param: string,
  context: Context,
): string | undefined {
  if (!isScalar(value)) return undefined;
  const text = String(value);
  if (text.length < 3 || text.includes("{") || SECRET_FIELD.test(param)) return undefined;
  const named = context.demonstrated.get(text);
  if (named) return template(named, text, "input", context);
  if (context.typed.has(text))
    return template(inputName(context.typed.get(text), text), text, "typed", context);
  const reference = index === undefined ? undefined : referenceOf(text, index, param, context);
  return reference;
}

/**
 * `{{steps.<i>.<path>}}` when the value came from an earlier answer, and exactly one place in
 * those answers holds it. A literal that appears twice (or in two answers) stays a literal: a
 * guessed reference would send another answer's value on a later run.
 */
function referenceOf(
  value: string,
  before: number,
  param: string,
  context: Context,
): string | undefined {
  const matches = earlierMatches(context.responses, before, value);
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  if (!match) return undefined;
  const from = `steps.${match.index}.${match.path}`;
  context.refs.push({ step: before, param, from });
  return `{{${from}}}`;
}

function earlierMatches(
  responses: unknown[],
  before: number,
  value: string,
): { index: number; path: string }[] {
  const matches: { index: number; path: string }[] = [];
  for (let index = 0; index < before; index++)
    for (const path of pathsOf(responses[index], value)) matches.push({ index, path });
  return matches;
}

function* pathsOf(response: unknown, value: string): Generator<string> {
  if (response === undefined) return;
  for (const [pointer, leaf] of leaves(response)) {
    if (!pointer || !isScalar(leaf)) continue;
    if (String(leaf) !== value) continue;
    yield pointer.slice(1).replace(/\//g, ".");
  }
}

function inferSteps(steps: unknown[] | undefined, context: Context): unknown[] | undefined {
  if (!Array.isArray(steps)) return steps;
  return steps.map((step) => {
    if (!step || typeof step !== "object") return step;
    const saved = step as { kind?: unknown; args?: unknown; target?: { name?: string } };
    if (typeof saved.kind !== "string" || !TYPED_KINDS.has(saved.kind)) return step;
    if (!Array.isArray(saved.args)) return step;
    const args = saved.args.map((arg, index) =>
      index === 0 ? typedArg(arg, saved, context) : arg,
    );
    return { ...saved, args };
  });
}

function typedArg(
  value: unknown,
  step: { kind?: unknown; target?: { name?: string } },
  context: Context,
): unknown {
  if (typeof value !== "string" || value.length < 3 || value.includes("{")) return value;
  if (SECRET_FIELD.test(step.target?.name ?? "")) return value;
  const from = step.kind === "upload" ? "upload" : "typed";
  const named = context.demonstrated.get(value);
  if (named) return template(named, value, from, context);
  if (context.typed.has(value))
    return template(inputName(context.typed.get(value), value), value, from, context);
  return value;
}

/** Rewrites a page URL or an api `open` URL whose query value is an input. */
function queryUrl(url: string, context: Context): string | undefined {
  let changed = false;
  const next = url.replace(
    /([?&])([^=&#]+)=([^&#]*)/g,
    (whole, separator: string, key: string, raw: string) => {
      if (raw.includes("{") || raw.length < 3) return whole;
      const value = safeDecode(raw);
      const byValue = context.demonstrated.get(value);
      if (!byValue && !context.properties[key]) return whole;
      const name = context.properties[key] ? key : (byValue ?? key);
      changed = true;
      return `${separator}${key}=${template(name, value, "query", context)}`;
    },
  );
  return changed ? next : undefined;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

type InputFrom = "typed" | "input" | "query" | "upload";

function template(name: string, example: string, from: InputFrom, context: Context): string {
  return `{{inputs.${ensureInput(name, example, from, context)}}}`;
}

function ensureInput(wanted: string, example: string, from: InputFrom, context: Context): string {
  const base = camelName(wanted) || "value";
  if (context.properties[base]) return base;
  const same = Object.entries(context.properties).find(
    ([, spec]) => String(spec.example ?? "") === example,
  );
  if (same) return same[0];
  const name = freeName(base, context);
  const upload = from === "upload";
  const secret = upload || looksSecretValue(example);
  context.properties[name] = {
    type: "string",
    ...(upload ? { format: "path", "x-upload": true } : {}),
    ...(secret ? {} : { example }),
    "x-from": from,
    ...(secret
      ? {
          description: upload
            ? "Workspace path of the file to upload; the recorded path was not stored"
            : "Typed during the run; the value was not stored",
        }
      : {}),
  };
  context.added.push(name);
  return name;
}

function freeName(base: string, context: Context): string {
  if (!context.properties[base]) return base;
  for (let index = 2; ; index++) {
    const next = `${base}${index}`;
    if (!context.properties[next]) return next;
  }
}

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

function inputName(field: string | undefined, value: string): string {
  if (field) return field;
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join("-");
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

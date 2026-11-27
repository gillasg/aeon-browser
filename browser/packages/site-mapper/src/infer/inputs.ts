import type { JsonSchema, Param } from "../types.js";
import { looksGenerated } from "./volatile.js";

// One rule for query and body fields alike. A value recorded the same every time is hidden only
// when it is protocol plumbing (a response format, a JSONP callback, an API version) or a value
// the client minted. Anything else is the caller's: an optional input whose default is what the
// site sent.

const PLUMBING =
  /^(format|formatversion|callback|cb|jsonp|_|_data|v|ver|version|api_?version|apiversion|locale|lang|hl|client|utf8|origin|errorformat)$/i;
const SEARCH_WORDS = /^(q|query|term|search|keywords?|text|name|title)$/i;
const ENUM_MIN_SAMPLES = 20;
const ENUM_MAX_DISTINCT = 6;
const MAX_EXAMPLES = 5;

/** Plumbing the caller never chooses: stays a hidden constant. */
export function isPlumbing(name: string, value: unknown): boolean {
  return PLUMBING.test(name) || looksGenerated(value);
}

/**
 * An input's schema keeps `enum` only with plenty of evidence: at least 20 samples and at most
 * 6 values, and never for free text (search words) or a path slug.
 */
export function inputSchema(
  schema: JsonSchema,
  name: string,
  values: readonly unknown[],
  slug = false,
): JsonSchema {
  if (!schema.enum) return schema;
  const distinct = new Set(values.map((value) => JSON.stringify(value))).size;
  const enough = values.length >= ENUM_MIN_SAMPLES && distinct <= ENUM_MAX_DISTINCT;
  if (enough && !slug && !SEARCH_WORDS.test(name)) return schema;
  const rest = { ...schema };
  delete rest.enum;
  return rest;
}

export function inputExamples(values: readonly string[]): string[] {
  return [...new Set(values)].slice(0, MAX_EXAMPLES);
}

/** A recorded constant: hidden plumbing (`constant`) or the caller's optional input (`default`). */
export function constantOrDefault(param: Param, value: string): void {
  if (isPlumbing(param.name, value)) {
    param.constant = value;
    return;
  }
  param.default = value;
  param.required = false;
}

/** Splits body constants into hidden plumbing and caller defaults. */
export function splitBodyConstants<T>(constants: Record<string, T> | undefined): {
  constants?: Record<string, T>;
  defaults?: Record<string, T>;
} {
  if (!constants) return {};
  const hidden: Record<string, T> = {};
  const defaults: Record<string, T> = {};
  for (const [key, value] of Object.entries(constants))
    (isPlumbing(key, value) ? hidden : defaults)[key] = value;
  return {
    ...(Object.keys(hidden).length ? { constants: hidden } : {}),
    ...(Object.keys(defaults).length ? { defaults } : {}),
  };
}

// A way accepts an answer by the shape it recorded, not by looking plausible. The check compares
// required fields and their types through diff.ts, so a price, count or timestamp never reads as
// drift; a recorded list that is missing is drift even when an empty answer would look fine.
// A way that drifts is tried, then the next way; it is marked unverified, never deleted.

import { breakingChanges, schemaChanges, resolveAll } from "./diff.js";
import { getPointer, inferSchema } from "./infer/schema.js";
import type { Ability, AbilityWay, AbilityWayExpect } from "./abilities.js";
import { wayId } from "./ability-stats.js";

export interface AnswerShape {
  shape: Record<string, unknown>;
  list?: string;
}

const LIST_KEYS = ["items", "records", "results", "data"];

/** The shape of one answer: required fields and types, and where its list is. */
export function shapeOf(result: unknown): AnswerShape | undefined {
  if (result === undefined || result === null || typeof result !== "object") return undefined;
  const shape = inferSchema([result]);
  if (!shape || "note" in shape) return undefined;
  const list = listPointer(result);
  return { shape, ...(list !== undefined ? { list } : {}) };
}

function listPointer(result: unknown): string | undefined {
  if (Array.isArray(result)) return "";
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  for (const key of LIST_KEYS) if (Array.isArray(record[key])) return "/" + key;
  return undefined;
}

/** The shape a way's answer must keep: its declared expect, else what it answered before. */
export function expectedShape(ability: Ability, way: AbilityWay): AbilityWayExpect | undefined {
  const declared = declaredExpect(way);
  const learned = ability.stats?.ways?.[wayId(way)];
  return expectOf(declared?.shape ?? learned?.shape, declared?.list ?? learned?.list);
}

function declaredExpect(way: AbilityWay): AbilityWayExpect | undefined {
  return way.kind === "steps" ? undefined : way.expect;
}

function expectOf(
  shape: Record<string, unknown> | undefined,
  list: string | undefined,
): AbilityWayExpect | undefined {
  if (shape === undefined && list === undefined) return undefined;
  const expect: AbilityWayExpect = {};
  if (shape !== undefined) expect.shape = shape;
  if (list !== undefined) expect.list = list;
  return expect;
}

/** Why the answer is not the recorded shape, or undefined when it is. */
export function shapeDrift(
  expected: AbilityWayExpect | undefined,
  result: unknown,
): string | undefined {
  if (!expected) return undefined;
  const list = listDrift(expected.list, result);
  if (list) return list;
  if (!expected.shape || result === undefined) return undefined;
  const changes = schemaChanges(resolveAll(undefined, expected.shape), inferSchema([result]));
  const breaking = changes.filter((line) => breakingChanges([line]));
  if (!breaking.length) return undefined;
  return `the recorded shape changed: ${breaking.slice(0, 4).join("; ")}`;
}

/** A recorded list must still be there; an empty one is a result, a missing one is drift. */
function listDrift(pointer: string | undefined, result: unknown): string | undefined {
  if (pointer === undefined) return undefined;
  const value = getPointer(result, pointer);
  if (Array.isArray(value)) return undefined;
  return `the recorded list at ${pointer || "/"} is missing`;
}

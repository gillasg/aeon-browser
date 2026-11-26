// A compact JSON Schema for what a mapped operation answers, as MCP `outputSchema`. MCP needs an
// object root, so a list answer is described as `{ items: [...] }` and any other non-object answer
// as `{ value: ... }`; `structuredOutput` wraps a live answer the same way so the two always match.
// Bounded on purpose: a few levels deep, a few dozen properties, never sample values or enums.

import type { Operation } from "./types.js";

type Schema = Record<string, unknown>;

export interface OutputSchemaOptions {
  maxDepth?: number;
  maxProperties?: number;
}

interface Bounds {
  maxDepth: number;
  maxProperties: number;
}

function bounds(opts: OutputSchemaOptions | undefined): Bounds {
  return { maxDepth: opts?.maxDepth ?? 4, maxProperties: opts?.maxProperties ?? 30 };
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return kindOf(value) === "object";
}

function typeField(kinds: Set<string>): string | string[] | undefined {
  if (kinds.has("integer") && kinds.has("number")) kinds.delete("integer");
  const list = [...kinds].filter((kind) => kind !== "undefined").sort();
  if (!list.length) return undefined;
  return list.length === 1 ? list[0] : list;
}

function objectSchema(objects: Record<string, unknown>[], depth: number, b: Bounds): Schema {
  const keys: string[] = [];
  for (const object of objects)
    for (const key of Object.keys(object)) if (!keys.includes(key)) keys.push(key);
  const kept = keys.slice(0, b.maxProperties);
  const properties: Schema = {};
  for (const key of kept)
    properties[key] = merge(
      objects.filter((object) => key in object).map((object) => object[key]),
      depth + 1,
      b,
    );
  // No `required`: a key seen in every sample can still be absent from a valid live answer, and a
  // client that validates output would then reject the reply.
  return { type: "object", properties };
}

function merge(samples: unknown[], depth: number, b: Bounds): Schema {
  const kinds = new Set(samples.map(kindOf));
  const type = typeField(new Set(kinds));
  const schema: Schema = type ? { type } : {};
  if (depth >= b.maxDepth) return schema;
  const objects = samples.filter(isRecord);
  if (objects.length) Object.assign(schema, objectSchema(objects, depth, b), { type });
  const elements = samples.filter(Array.isArray).flat();
  if (kinds.has("array") && elements.length) schema.items = merge(elements, depth + 1, b);
  return schema;
}

/** The schema for one or more answers of the same operation; undefined when there are none. */
export function inferOutputSchema(
  samples: unknown[],
  opts?: OutputSchemaOptions,
): Record<string, unknown> | undefined {
  // The root is an object or a wrapper, so a null answer says nothing about its shape.
  const seen = samples.filter((sample) => sample !== undefined && sample !== null);
  if (!seen.length) return undefined;
  return objectRoot(merge(seen, 1, bounds(opts)));
}

/** Wraps a non-object schema so the root is `type: "object"`, as MCP requires. */
export function objectRoot(schema: Schema): Schema {
  if (schema.type === "object") return schema;
  const key = schema.type === "array" ? "items" : "value";
  return { type: "object", properties: { [key]: schema }, required: [key] };
}

/** A recorded response schema, trimmed to the same bounds and given an object root. */
export function outputSchemaFromJsonSchema(
  schema: Schema | undefined,
  opts?: OutputSchemaOptions,
): Schema | undefined {
  if (!schema || typeof schema !== "object" || !schema.type) return undefined;
  return objectRoot(trim(schema, 1, bounds(opts)));
}

/** Drops `required` below the root wrapper: recorded and saved schemas come from samples. */
function optional(schema: Schema, root: boolean): Schema {
  const out: Schema = { ...schema };
  if (!(root && isWrapper(schema))) delete out.required;
  if (out.properties && typeof out.properties === "object")
    out.properties = Object.fromEntries(
      Object.entries(out.properties as Record<string, Schema>).map(([k, v]) => [
        k,
        v && typeof v === "object" ? optional(v, false) : v,
      ]),
    );
  if (out.items && typeof out.items === "object") out.items = optional(out.items as Schema, false);
  return out;
}

function isWrapper(schema: Schema): boolean {
  const keys = Object.keys((schema.properties ?? {}) as Schema);
  return keys.length === 1 && (keys[0] === "items" || keys[0] === "value");
}

function trim(schema: Schema, depth: number, b: Bounds): Schema {
  const out: Schema = {};
  if (schema.type !== undefined) out.type = schema.type;
  if (depth >= b.maxDepth) return out;
  if (schema.properties && typeof schema.properties === "object") {
    const entries = Object.entries(schema.properties as Record<string, Schema>).slice(
      0,
      b.maxProperties,
    );
    out.properties = Object.fromEntries(entries.map(([k, v]) => [k, trim(v ?? {}, depth + 1, b)]));
  }
  if (schema.items && typeof schema.items === "object")
    out.items = trim(schema.items as Schema, depth + 1, b);
  return out;
}

/** The live answer in the shape its `outputSchema` describes. */
export function structuredOutput(
  value: unknown,
  outputSchema: Schema,
): Record<string, unknown> | undefined {
  const properties = (outputSchema.properties ?? {}) as Schema;
  const wrapped = Object.keys(properties).length === 1 && outputSchema.required;
  if (wrapped && "items" in properties && Array.isArray(value)) return { items: value };
  if (isRecord(value)) return value;
  if (wrapped && "value" in properties && value !== undefined) return { value };
  return undefined;
}

/** The operation's saved `outputSchema`, else one from its recorded 2xx JSON response schema. */
export function operationOutputSchema(operation: Operation): Record<string, unknown> | undefined {
  if (operation.outputSchema?.type === "object") return optional(operation.outputSchema, true);
  const ok = Object.entries(operation.responses ?? {})
    .filter(([status]) => /^2/.test(status))
    .sort(([a], [b]) => a.localeCompare(b))
    .find(([, response]) => /json/i.test(response.mime) && response.schema);
  return outputSchemaFromJsonSchema(ok?.[1].schema);
}

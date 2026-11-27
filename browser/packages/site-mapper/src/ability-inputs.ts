// Checks a run's inputs against the ability's declared JSON schema before any way runs, so a
// missing or mistyped input fails as ABILITY_INPUT with nothing sent and no write key claimed.
// The only coercion: a numeric string becomes a number when the schema says number or integer.

import { unknownInputMessage } from "./ability-contract.js";
import type { Ability } from "./abilities.js";

interface FieldSchema {
  type?: string | string[];
  enum?: unknown[];
}

/** The inputs to run with (numbers coerced), or an ABILITY_INPUT error naming the first bad field. */
export function checkAbilityInputs(
  ability: Ability,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  const unknown = unknownInputMessage(ability, inputs);
  if (unknown) throw new Error(unknown);
  const schema = (ability.inputs ?? {}) as { properties?: unknown; required?: unknown };
  const properties = (
    schema.properties && typeof schema.properties === "object" ? schema.properties : {}
  ) as Record<string, FieldSchema>;
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  for (const name of required)
    if (inputs[name] === undefined)
      throw new Error(`ABILITY_INPUT: ${name} is required${typeLabel(properties[name])}`);
  const out: Record<string, unknown> = { ...inputs };
  for (const [name, value] of Object.entries(inputs)) {
    const field = properties[name];
    if (!field || typeof field !== "object" || value === undefined) continue;
    out[name] = checkField(name, value, field);
  }
  return out;
}

function checkField(name: string, value: unknown, field: FieldSchema): unknown {
  const types = typesOf(field);
  const coerced = coerce(value, types);
  if (types.length && !types.some((type) => isType(coerced, type)))
    throw new Error(`ABILITY_INPUT: ${name} must be ${types.join(" or ")}, got ${describe(value)}`);
  if (Array.isArray(field.enum) && !field.enum.some((item) => same(item, coerced)))
    throw new Error(
      `ABILITY_INPUT: ${name} must be one of ${field.enum.map((item) => JSON.stringify(item)).join(", ")}, got ${describe(value)}`,
    );
  return coerced;
}

function typesOf(field: FieldSchema | undefined): string[] {
  if (!field) return [];
  if (typeof field.type === "string") return [field.type];
  return Array.isArray(field.type) ? field.type.map(String) : [];
}

function typeLabel(field: FieldSchema | undefined): string {
  const types = typesOf(field);
  return types.length ? ` (${types.join(" or ")})` : "";
}

function coerce(value: unknown, types: string[]): unknown {
  if (typeof value !== "string" || types.includes("string")) return value;
  if (!types.includes("number") && !types.includes("integer")) return value;
  const text = value.trim();
  if (!text || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return value;
  return Number(text);
}

function isType(value: unknown, type: string): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "array") return Array.isArray(value);
  if (type === "null") return value === null;
  if (type === "object")
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return true;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return `the string ${JSON.stringify(value.slice(0, 40))}`;
  if (typeof value === "object") return "an object";
  return `${typeof value} ${String(value)}`;
}

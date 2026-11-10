// The contract is the ability: inputs, outputs, and whether a way met them. A way that misses
// required output fields is not a fallback. A way that only has part of the data says `partial`,
// and a caller that needs all of it skips that way. Preconditions are checked when the host can
// answer them; a write's postcondition is its read-back.

import type { Ability, AbilityHost, AbilityWay } from "./abilities.js";
import type { ReadBack } from "./ability-writes.js";

export interface AbilityPrecondition {
  /** The site session must be signed in. */
  signedIn?: boolean;
  /** Page type this ability expects, when the host can name the current one. */
  pageType?: string;
}

/** What must hold before a write is confirmed: the read-back. */
export type AbilityPostcondition = ReadBack;

export async function preconditionError(
  ability: Ability,
  host: AbilityHost,
): Promise<string | undefined> {
  const pre = ability.preconditions;
  if (!pre) return undefined;
  if (pre.signedIn && host.signedIn && !(await host.signedIn()))
    return `ABILITY_PRECONDITION: ${ability.name} needs a signed-in session`;
  return pageTypeError(ability, pre.pageType, host);
}

async function pageTypeError(
  ability: Ability,
  pageType: string | undefined,
  host: AbilityHost,
): Promise<string | undefined> {
  if (!pageType || !host.pageType) return undefined;
  const page = await host.pageType();
  if (!page || page === pageType) return undefined;
  return `ABILITY_PRECONDITION: ${ability.name} needs page type ${pageType} (on ${page})`;
}

/** Required output fields missing from an object result. Arrays are lists, not the object contract. */
export function contractGap(
  ability: Pick<Ability, "outputs">,
  result: unknown,
): string | undefined {
  const required = requiredFields(ability.outputs);
  if (!required.length || !result || typeof result !== "object" || Array.isArray(result))
    return undefined;
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(result, key));
  return missing.length ? `missing ${missing.join(", ")}` : undefined;
}

function requiredFields(outputs: Ability["outputs"]): string[] {
  const required = (outputs as { required?: unknown } | undefined)?.required;
  return Array.isArray(required)
    ? required.filter((item): item is string => typeof item === "string")
    : [];
}

/** A way, or its result, that only has part of what the contract names. */
export function isPartial(way: AbilityWay, result: unknown): boolean {
  if (way.partial) return true;
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const record = result as Record<string, unknown>;
  return record.partial === true || record.complete === false;
}

export function readBackOf(ability: Ability): ReadBack | undefined {
  return ability.options.readBack ?? ability.postcondition;
}

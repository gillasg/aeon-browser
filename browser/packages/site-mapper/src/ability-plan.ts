// How a browser cell runs an ability: page code runs in the cell itself, so it shares the
// cell's tabs and the user's login; everything else goes through runAbility.

import { readAbility, withBuiltinWay, type AbilityVia } from "./abilities.js";
import { siteName } from "./registry.js";

export interface AbilityPlan {
  /** Run it in the calling browser cell: the code, the site's host, and its third argument. */
  local: boolean;
  code?: string;
  host?: string;
  input?: Record<string, unknown>;
  /** Built-in code opens its own tabs; it gets the caller's page (withPage reads it). */
  opensOwnTab?: boolean;
}

/**
 * How a browser cell should run an ability: in the cell itself when it is page code (the
 * built-in ones, or a read whose first way is a page script), so it shares the cell's tabs and
 * login; otherwise through runAbility.
 */
export async function abilityPlan(
  site: string,
  name: string,
  inputs: Record<string, unknown> = {},
  via?: AbilityVia,
): Promise<AbilityPlan> {
  const ability = withBuiltinWay(await readAbility(site, name), inputs);
  if (!ability) throw new Error(`ABILITY_UNKNOWN: ${siteName(site)} has no ability ${name}`);
  const way = ability.ways[0];
  if (ability.kind !== "read" || way?.kind !== "script" || way.runtime !== "page")
    return { local: false };
  if (via && via !== "script") return { local: false };
  const code = /^\s*(async\s*)?\(/.test(way.code)
    ? way.code
    : `async (page, bu, inputs) => { ${way.code}\n return inputs; }`;
  const extra = (way.input && typeof way.input === "object" ? way.input : {}) as Record<
    string,
    unknown
  >;
  return {
    local: true,
    code,
    host: siteName(site),
    input: { inputs, ...extra },
    opensOwnTab: ability.createdBy === "builtin",
  };
}

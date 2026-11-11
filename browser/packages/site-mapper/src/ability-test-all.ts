// `aeon abilities test --all`. Dry mode checks stored cases without calling a site, so unit
// tests and a machine with no browser can still run it.

import { readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { listAbilities, type Ability, type AbilityHost } from "./abilities.js";
import { unusedInputs, testAbilityCases } from "./ability-contract.js";
import { siteDir } from "./registry.js";

export interface AbilityTestRow {
  site: string;
  name: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

export async function testAllAbilities(
  options: { dry?: boolean; host?: AbilityHost; sites?: string[] } = {},
): Promise<AbilityTestRow[]> {
  const sites = options.sites ?? (await readdir(dirname(siteDir("x"))).catch(() => [] as string[]));
  const rows: AbilityTestRow[] = [];
  for (const site of sites) {
    for (const ability of await listAbilities(site))
      rows.push(await oneAbility(ability, options.dry !== false, options.host));
  }
  return rows;
}

async function oneAbility(
  ability: Ability,
  dry: boolean,
  host: AbilityHost | undefined,
): Promise<AbilityTestRow> {
  if (ability.kind === "write" || ability.createdBy === "builtin")
    return { site: ability.site, name: ability.name, ok: true, skipped: true };
  if (dry || !host) return dryCheck(ability);
  return liveCheck(ability, host);
}

async function dryCheck(ability: Ability): Promise<AbilityTestRow> {
  const unused = ability.createdBy === "agent" ? unusedInputs(ability) : [];
  if (unused.length)
    return {
      site: ability.site,
      name: ability.name,
      ok: false,
      error: `unused ${unused.join(", ")}`,
    };
  if (!ability.tests?.length)
    return { site: ability.site, name: ability.name, ok: true, skipped: true };
  const report = await testAbilityCases(ability, async (inputs) => {
    const test = ability.tests?.find(
      (item) => JSON.stringify(item.inputs) === JSON.stringify(inputs),
    );
    return test?.expect ?? { inputs };
  });
  const error = report.constant ? "constant" : report.ok ? undefined : "failed";
  return { site: ability.site, name: ability.name, ok: report.ok, ...(error ? { error } : {}) };
}

async function liveCheck(ability: Ability, host: AbilityHost): Promise<AbilityTestRow> {
  const report = await testAbilityCases(ability, async (inputs) => {
    const { runAbility } = await import("./abilities.js");
    return (await runAbility(ability.site, ability.name, inputs, { host })).result;
  });
  return {
    site: ability.site,
    name: ability.name,
    ok: report.ok,
    ...(report.ok ? {} : { error: report.constant ? "constant" : "failed" }),
  };
}

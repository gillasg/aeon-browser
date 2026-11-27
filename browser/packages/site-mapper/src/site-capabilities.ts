// One answer for what can be done on a site: its abilities, the mapped operations they can use,
// and the site's SKILL.md brief. WebMCP tools are added by the browser runtime, which can see the page.

import { abilityEffect, operationEffect, type CallEffect } from "./effect.js";
import { listAbilities, type Ability, type AbilityPrecondition } from "./abilities.js";
import { untestedWays } from "./ability-digest.js";
import { readHealState, type HealReceipt, type HealState } from "./ability-heal.js";
import type { AbilityWrite } from "./ability-effects.js";
import { wayId } from "./ability-stats.js";
import { capabilityIndex } from "./infer/capabilities.js";
import { operationInputs } from "./params.js";
import { loadModel, siteName } from "./registry.js";
import { siteSkillBrief } from "./site-skill.js";

export interface SiteAbilitySummary {
  name: string;
  title: string;
  does: "read" | "write";
  effect: CallEffect;
  /** Lookups are reads, changes are writes. Same abilities, shown apart. */
  group: "lookup" | "change";
  inputs: string[];
  ways: string[];
  /** A way only has part of the result. */
  partial?: boolean;
  stale?: boolean;
  /** At least one way changed since its tests last passed. */
  untested?: boolean;
  /** Ways whose answer no longer matched the shape they recorded. */
  unverified?: { via: string; why?: string }[];
  /** What the ways change, explicit or suspected. An inventory, never a gate. */
  writes?: AbilityWrite[];
  preconditions?: AbilityPrecondition;
  /** Read ability a write uses to confirm itself. */
  postcondition?: string;
  stats?: Ability["stats"];
  /** Counted from 1; each save that changes the ability is the next version. */
  version?: number;
  /** The last repair of a drifted way: `Repaired <name> (v1 → v2)`. */
  healed?: HealReceipt;
}

export interface SiteOperationSummary {
  name: string;
  title: string;
  does: "read" | "write";
  effect: CallEffect;
  inputs: string[];
  capabilities?: string[];
}

export interface SiteCapabilities {
  site: string;
  /** Reads first, then writes. */
  abilities: SiteAbilitySummary[];
  /** Reads: things Graft can look up. */
  lookups: SiteAbilitySummary[];
  /** Writes: things Graft can change. */
  changes: SiteAbilitySummary[];
  operations: SiteOperationSummary[];
  notes: string;
}

/** The merged inventory for a site. Missing stores simply contribute nothing. */
export async function siteCapabilities(site: string): Promise<SiteCapabilities> {
  const host = siteName(site);
  const [abilities, notes, model, heals] = await Promise.all([
    listAbilities(host).catch(() => []),
    siteSkillBrief(host).catch(() => ""),
    loadModel(host).catch(() => undefined),
    readHealState(host),
  ]);
  const operations = model?.operations ?? [];
  const index = capabilityIndex(operations);
  const roles = new Map<string, string[]>();
  for (const [capability, ids] of Object.entries(index))
    for (const id of ids ?? []) roles.set(id, [...(roles.get(id) ?? []), capability]);
  const summaries = abilities.map((item) => summarize(item, heals)).sort(lookupsFirst);
  return {
    site: host,
    ...grouped(summaries),
    operations: operations.map((operation) => {
      const effect = operationEffect(operation);
      return {
        name: operation.id,
        title: operation.summary ?? operation.id,
        does: effect === "read" ? ("read" as const) : ("write" as const),
        effect,
        inputs: operationInputs(operation),
        ...(roles.get(operation.id)?.length ? { capabilities: roles.get(operation.id) } : {}),
      };
    }),
    notes,
  };
}

function summarize(ability: Ability, heals: HealState): SiteAbilitySummary {
  const post = ability.postcondition?.ability ?? ability.options.readBack?.ability;
  const effect = abilityEffect(ability);
  const kind = readOrWrite(effect);
  return {
    name: ability.name,
    title: ability.description ?? ability.name,
    does: kind.does,
    effect,
    group: kind.group,
    inputs: Object.keys((ability.inputs.properties ?? {}) as Record<string, unknown>),
    ways: ability.ways.map((way) => way.kind),
    ...(ability.ways.some((way) => way.partial) ? { partial: true } : {}),
    ...(ability.stats?.stale ? { stale: true } : {}),
    ...untestedField(ability),
    ...unverifiedField(ability),
    ...writesField(ability),
    ...(ability.preconditions ? { preconditions: ability.preconditions } : {}),
    ...(post ? { postcondition: post } : {}),
    ...versionFields(ability, heals),
    stats: ability.stats,
  };
}

/** The version number, and the last repair of a drifted way when there was one. */
function versionFields(
  ability: Ability,
  heals: HealState,
): Pick<SiteAbilitySummary, "version" | "healed"> {
  const healed = heals[ability.name]?.last;
  return {
    ...(ability.version ? { version: ability.version } : {}),
    ...(healed ? { healed } : {}),
  };
}

function untestedField(ability: Ability): { untested?: boolean } {
  return untestedWays(ability).length ? { untested: true } : {};
}

/** The writes inventory, shown to the model and the UI. Never read before a run. */
function writesField(ability: Ability): { writes?: AbilityWrite[] } {
  return ability.writes?.length ? { writes: ability.writes } : {};
}

/** Ways whose last answer no longer matched the recorded shape. They are kept, not removed. */
function unverifiedField(ability: Ability): { unverified?: { via: string; why?: string }[] } {
  const ways = ability.ways.flatMap((way) => {
    const stats = ability.stats?.ways?.[wayId(way)];
    if (!stats?.unverified) return [];
    return [{ via: way.kind, ...(stats.unverifiedWhy ? { why: stats.unverifiedWhy } : {}) }];
  });
  return ways.length ? { unverified: ways } : {};
}

function readOrWrite(effect: CallEffect): {
  does: "read" | "write";
  group: "lookup" | "change";
} {
  return effect === "read" ? { does: "read", group: "lookup" } : { does: "write", group: "change" };
}

function lookupsFirst(left: SiteAbilitySummary, right: SiteAbilitySummary): number {
  if (left.does !== right.does) return left.does === "read" ? -1 : 1;
  return left.name.localeCompare(right.name);
}

function grouped(
  items: SiteAbilitySummary[],
): Pick<SiteCapabilities, "abilities" | "lookups" | "changes"> {
  const lookups = items.filter((item) => item.does !== "write");
  const changes = items.filter((item) => item.does === "write");
  return { abilities: [...lookups, ...changes], lookups, changes };
}

/** Merge WebMCP tools the page exposes into the same answer. */
export function withWebMcp(
  base: SiteCapabilities,
  tools: { name: string; description?: string }[],
): SiteCapabilities {
  const clean = tools.filter((tool) => tool.name);
  if (!clean.length) return base;
  const abilities = [
    ...base.abilities,
    ...clean.map((tool) => ({
      name: tool.name,
      title: tool.description ?? tool.name,
      does: "read" as const,
      effect: "read" as const,
      group: "lookup" as const,
      inputs: [],
      ways: ["webmcp"],
    })),
  ];
  return { ...base, ...grouped(abilities) };
}

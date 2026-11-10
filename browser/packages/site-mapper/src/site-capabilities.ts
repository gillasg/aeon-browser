// One answer for what can be done on a site: its abilities, the mapped operations they can use,
// and the site's notes. WebMCP tools are added by the browser runtime, which can see the page.

import {
  listAbilities,
  readSiteNotes,
  type Ability,
  type AbilityPrecondition,
} from "./abilities.js";
import { capabilityIndex } from "./infer/capabilities.js";
import { inputParams } from "./params.js";
import { loadModel, siteName } from "./registry.js";

export interface SiteAbilitySummary {
  name: string;
  title: string;
  does: "read" | "write";
  /** Lookups are reads, changes are writes. Same abilities, shown apart. */
  group: "lookup" | "change";
  inputs: string[];
  ways: string[];
  /** A way only has part of the result. */
  partial?: boolean;
  stale?: boolean;
  preconditions?: AbilityPrecondition;
  /** Read ability a write uses to confirm itself. */
  postcondition?: string;
  stats?: Ability["stats"];
}

export interface SiteOperationSummary {
  name: string;
  title: string;
  does: "read" | "write";
  inputs: string[];
  capabilities?: string[];
}

export interface SiteCapabilities {
  site: string;
  /** Reads first, then writes. */
  abilities: SiteAbilitySummary[];
  /** Reads: things Aeon can look up. */
  lookups: SiteAbilitySummary[];
  /** Writes: things Aeon can change. */
  changes: SiteAbilitySummary[];
  operations: SiteOperationSummary[];
  notes: string;
}

/** The merged inventory for a site. Missing stores simply contribute nothing. */
export async function siteCapabilities(site: string): Promise<SiteCapabilities> {
  const host = siteName(site);
  const [abilities, notes, model] = await Promise.all([
    listAbilities(host).catch(() => []),
    readSiteNotes(host).catch(() => ""),
    loadModel(host).catch(() => undefined),
  ]);
  const operations = model?.operations ?? [];
  const index = capabilityIndex(operations);
  const roles = new Map<string, string[]>();
  for (const [capability, ids] of Object.entries(index))
    for (const id of ids ?? []) roles.set(id, [...(roles.get(id) ?? []), capability]);
  const summaries = abilities.map(summarize).sort(lookupsFirst);
  return {
    site: host,
    ...grouped(summaries),
    operations: operations.map((operation) => ({
      name: operation.id,
      title: operation.summary ?? operation.id,
      does: operation.role === "read" ? "read" : "write",
      inputs: inputParams(operation).map((param) => param.name),
      ...(roles.get(operation.id)?.length ? { capabilities: roles.get(operation.id) } : {}),
    })),
    notes,
  };
}

function summarize(ability: Ability): SiteAbilitySummary {
  const post = ability.postcondition?.ability ?? ability.options.readBack?.ability;
  return {
    name: ability.name,
    title: ability.description ?? ability.name,
    does: ability.kind,
    group: ability.kind === "write" ? "change" : "lookup",
    inputs: Object.keys((ability.inputs.properties ?? {}) as Record<string, unknown>),
    ways: ability.ways.map((way) => way.kind),
    ...(ability.ways.some((way) => way.partial) ? { partial: true } : {}),
    ...(ability.stats?.stale ? { stale: true } : {}),
    ...(ability.preconditions ? { preconditions: ability.preconditions } : {}),
    ...(post ? { postcondition: post } : {}),
    stats: ability.stats,
  };
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
      group: "lookup" as const,
      inputs: [],
      ways: ["webmcp"],
    })),
  ];
  return { ...base, ...grouped(abilities) };
}

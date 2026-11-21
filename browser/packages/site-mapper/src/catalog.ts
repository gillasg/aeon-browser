import { createHash } from "node:crypto";
import type { Ability } from "./abilities.js";
import { abilityEffect, effectAnnotations, operationEffect, type CallEffect } from "./effect.js";
import { operationInputSchema } from "./mcp.js";
import type { SiteModel } from "./types.js";

type Json = Record<string, unknown>;

/** One mapped operation or saved ability, named for the unified MCP catalog. */
export interface CatalogTool {
  name: string;
  site: string;
  kind: "operation" | "ability";
  id: string;
  effect: CallEffect;
  description: string;
  inputSchema: Json;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
}

/** `amazon.in` + `searchProducts` → `site__amazon_in__searchProducts`. */
export function catalogToolsForSite(
  site: string,
  model: SiteModel | undefined,
  abilities: readonly Ability[],
  taken: Set<string>,
): CatalogTool[] {
  const tools: CatalogTool[] = [];
  for (const operation of model?.operations ?? []) {
    const effect = operationEffect(operation);
    tools.push({
      name: claimName(site, operation.id, taken, "operation"),
      site,
      kind: "operation",
      id: operation.id,
      effect,
      description: `${operation.summary ?? operation.description ?? operation.id}: ${operation.method} ${operation.path} (${effect}). Returns the operation's JSON value.`,
      inputSchema: operationInputSchema(operation),
      annotations: effectAnnotations(effect),
    });
  }
  for (const ability of abilities) {
    const effect = abilityEffect(ability);
    tools.push({
      name: claimName(site, ability.name, taken, "ability"),
      site,
      kind: "ability",
      id: ability.name,
      effect,
      description: `${ability.description ?? ability.name}: a saved ability on ${site} (${effect}). Returns {result, via}.`,
      inputSchema: {
        type: "object",
        ...((ability.inputs ?? {}) as Json),
      },
      annotations: effectAnnotations(effect),
    });
  }
  return tools;
}

/** Every term must appear in the name, site, id or description. */
export function searchCatalog(
  tools: readonly CatalogTool[],
  query: string,
  limit = 20,
): CatalogTool[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return tools
    .map((tool) => {
      const hay = `${tool.name} ${tool.site} ${tool.id} ${tool.description}`.toLowerCase();
      const score = terms.reduce((count, term) => count + (hay.includes(term) ? 1 : 0), 0);
      return { tool, score };
    })
    .filter((item) => item.score === terms.length)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map((item) => item.tool);
}

function claimName(
  site: string,
  id: string,
  taken: Set<string>,
  kind: "operation" | "ability",
): string {
  let base = `site__${slug(site)}__${slug(id)}`;
  if (kind === "ability" && taken.has(base)) base = `${base}_ability`;
  base = fit(base, site, id);
  let name = base;
  let n = 2;
  while (taken.has(name)) {
    const suffix = `_${n}`;
    n += 1;
    name = `${base.slice(0, 64 - suffix.length)}${suffix}`;
  }
  taken.add(name);
  return name;
}

function slug(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "item";
}

function fit(name: string, site: string, id: string): string {
  if (name.length <= 64) return name;
  const hash = createHash("sha256").update(`${site}\0${id}`).digest("hex").slice(0, 8);
  return `${name.slice(0, 64 - hash.length - 1)}_${hash}`;
}

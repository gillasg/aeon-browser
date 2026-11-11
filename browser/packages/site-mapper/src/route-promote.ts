// A route becomes a named ability after two successes with different inputs, a watcher, or the
// words again / every / whenever. The user is told afterwards. Nothing asks first.

import {
  createAbility,
  readAbility,
  saveAbility,
  trashAbility,
  type Ability,
} from "./abilities.js";
import { saveRouteEdits, type StageInput } from "./route-store.js";
import type { Route } from "./route-types.js";

const WORDS = /\b(again|every|whenever)\b/i;

export interface Promotion {
  ability: Ability;
  learned: { abilityId: string; name: string; site: string };
}

export function promotionReady(route: Route, prompt = "", watcher = false): boolean {
  if (route.abilityId) return false;
  if (watcher || route.watcher || WORDS.test(prompt)) return true;
  return route.okRuns >= 2 && distinctInputs(route) >= 2;
}

export async function promoteRoute(
  route: Route,
  options: { prompt?: string; watcher?: boolean } = {},
): Promise<Promotion | undefined> {
  if (!promotionReady(route, options.prompt ?? "", options.watcher === true)) return undefined;
  const drafted = abilityFromRoute(route);
  const saved = await createAbility(drafted);
  const abilityId = `${saved.ability.site}/${saved.ability.name}`;
  await saveRouteEdits(route.site, { ...route, abilityId });
  return {
    ability: saved.ability,
    learned: { abilityId, name: saved.ability.name, site: saved.ability.site },
  };
}

export async function renameAbility(site: string, from: string, to: string): Promise<Ability> {
  const current = await readAbility(site, from);
  if (!current) throw new Error(`ABILITY_UNKNOWN: ${site} has no ability ${from}`);
  const saved = await saveAbility({ ...current, name: to, updatedAt: new Date().toISOString() });
  if (current.createdBy !== "builtin") await trashAbility(site, from, "renamed");
  return saved.ability;
}

export async function forgetAbility(site: string, name: string): Promise<boolean> {
  return trashAbility(site, name, "forgotten");
}

function distinctInputs(route: Route): number {
  return new Set(route.inputHistory.map((item) => JSON.stringify(item))).size;
}

function abilityFromRoute(route: Route): Omit<Ability, "stats" | "createdAt" | "updatedAt"> {
  const name = abilityName(route);
  const properties = Object.fromEntries(
    route.inputs.map((input) => [input.name, { type: "string" }]),
  );
  const params = Object.fromEntries(
    route.inputs.map((input) => [input.name, `{{inputs.${input.name}}}`]),
  );
  const example = route.inputHistory[0] ?? {};
  return {
    name,
    site: route.site,
    description: route.summary,
    kind: route.writes ? "write" : "read",
    inputs: { type: "object", properties },
    outputs: { type: "object", properties: { result: { type: "string" } } },
    ways: [
      { kind: "steps", steps: route.steps, ...(Object.keys(params).length ? { params } : {}) },
    ],
    ...(route.writes ? {} : { tests: [{ inputs: example, expect: { result: route.summary } }] }),
    ...(route.writes
      ? { postcondition: { ability: `${name} check`, expect: { done: true } } }
      : {}),
    options: route.writes ? { readBack: { ability: `${name} check`, expect: { done: true } } } : {},
    createdBy: "agent",
    sourceKind: "route",
    promoted: true,
  };
}

function abilityName(route: Route): string {
  const words = route.summary
    .replace(/[^a-z0-9\s]+/gi, " ")
    .trim()
    .slice(0, 60);
  return words || "saved task";
}

export type { StageInput };

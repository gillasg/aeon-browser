// How to take back a write. A receipt for a write carries a `rewind` descriptor when the site's
// opposite action is known (remove ↔ add, follow ↔ unfollow) and the write is not irreversible.
// The UI shows `label` and hands the rest back; `siteMapper.undo` runs it.

import type { Ability } from "./abilities.js";
import { abilityEffect } from "./effect.js";
import { reverseOperation } from "./live.js";

export interface Rewind {
  kind: "ability-undo" | "site-script-undo" | "navigate-back";
  site?: string;
  operation?: string;
  params?: Record<string, unknown>;
  scriptId?: string;
  revision?: number;
  label: string;
}

/** `removeFromWatchLater` → `Undo remove from watch later`. */
export function undoLabel(operation: string): string {
  const words = operation
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();
  return words ? `Undo ${words}` : "Undo";
}

/**
 * The descriptor for undoing a proven write through the API, or undefined when it cannot be
 * taken back: no learned opposite, never sent through the API, or irreversible.
 */
export async function rewindForOperation(
  site: string,
  operation: string,
  params?: Record<string, unknown>,
): Promise<Rewind | undefined> {
  const plan = await reverseOperation(site, operation);
  if (!plan || plan.irreversible) return undefined;
  return {
    kind: "ability-undo",
    site,
    operation,
    ...(params && Object.keys(params).length ? { params } : {}),
    label: undoLabel(operation),
  };
}

/** The first of an ability's API steps that can be undone. An irreversible ability never can. */
export async function rewindForAbility(
  ability: Ability,
  params?: Record<string, unknown>,
): Promise<Rewind | undefined> {
  if (ability.kind !== "write" || abilityEffect(ability) === "irreversible") return undefined;
  for (const way of ability.ways) {
    if (way.kind !== "api") continue;
    const operations = [way.operation, ...(way.operations?.map((step) => step.operation) ?? [])];
    for (const operation of operations) {
      if (!operation) continue;
      const rewind = await rewindForOperation(ability.site, operation, params);
      if (rewind) return { ...rewind, label: undoLabel(ability.name) };
    }
  }
  return undefined;
}

/** The tab goes back one page. */
export function navigateBackRewind(label = "Go back"): Rewind {
  return { kind: "navigate-back", label };
}

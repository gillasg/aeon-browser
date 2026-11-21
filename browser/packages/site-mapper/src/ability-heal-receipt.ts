// The version number and the repair receipt of a save. A save that changes what an ability does
// archives the old content and moves the version on by one; when a drift was waiting on that
// ability, the same save is the repair, and its receipt says which version replaced which.

import type { Ability } from "./abilities.js";
import { pendingHeal, settleHeal, type HealReceipt } from "./ability-heal.js";
import { wayId } from "./ability-stats.js";
import { abilityVersionNumber, versionChangedAbility } from "./ability-versions.js";

export interface VersionedSave {
  ability: Ability;
  /** Set when this save repaired a drift that was waiting. */
  healed?: HealReceipt;
}

/** Archives the previous content when it changed, stamps the version, and settles a pending heal. */
export async function versionedSave(
  site: string,
  existing: Ability | undefined,
  next: Ability,
): Promise<VersionedSave> {
  if (!existing) return { ability: { ...next, version: 1 } };
  const from = await abilityVersionNumber(existing);
  const archived = await versionChangedAbility(existing, next);
  const to = archived ? from + 1 : from;
  const ability = { ...next, version: to };
  if (!archived) return { ability };
  const healed = await settled(site, existing, ability, from, to);
  return { ability, ...(healed ? { healed } : {}) };
}

async function settled(
  site: string,
  existing: Ability,
  next: Ability,
  fromVersion: number,
  toVersion: number,
): Promise<HealReceipt | undefined> {
  const pending = await pendingHeal(site, next.name).catch(() => undefined);
  if (!pending) return undefined;
  const receipt: HealReceipt = {
    fromVersion,
    toVersion,
    fromWay: pending.way,
    toWay: replacementWay(existing, next, pending.way),
    reason: pending.reason,
    at: new Date().toISOString(),
  };
  await settleHeal(site, next.name, receipt).catch(() => undefined);
  return receipt;
}

/** The way the repair added in place of the drifted one: same kind first, else any new way. */
function replacementWay(existing: Ability, next: Ability, drifted: string): string {
  const kind = drifted.split(":")[0];
  const before = new Set(existing.ways.map(wayId));
  const fresh = next.ways.filter((way) => !before.has(wayId(way)));
  const pick =
    fresh.find((way) => way.kind === kind) ??
    fresh[0] ??
    next.ways.find((way) => way.kind === kind) ??
    next.ways[0];
  return pick ? wayId(pick) : drifted;
}

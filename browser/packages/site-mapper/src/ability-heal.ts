// A way whose result no longer has the fields its schema names fails that way and queues a
// background heal. The ability falls through to the next way. The drift is remembered per ability,
// and the next save that really changes the ability settles it into a receipt a caller or the UI
// can show in one line: "Repaired search (v1 → v2)".

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { siteDir, siteName, writeAtomic } from "./registry.js";

/** What a repair changed: which version replaced which, and which way answered for the drifted one. */
export interface HealReceipt {
  /** The version that drifted, counted from 1. */
  fromVersion: number;
  /** The version the repair saved. */
  toVersion: number;
  /** The way that drifted, as `kind:hash`. */
  fromWay: string;
  /** The way that took its place. */
  toWay: string;
  reason: string;
  at: string;
}

/** A drift seen on a run or a check, waiting for the save that repairs it. */
export interface PendingHeal {
  way: string;
  reason: string;
  at: string;
}

interface HealEntry {
  pending?: PendingHeal;
  last?: HealReceipt;
  /** The last receipt was already returned on a run, so it is not announced again. */
  announced?: boolean;
}

export type HealState = Record<string, HealEntry>;

const STATE_FILE = "heal-state.json";

export async function queueHeal(
  site: string,
  name: string,
  way: string,
  reason: string,
): Promise<void> {
  // A bot check or a rate limit is not a broken ability. Repairing it would learn the wall.
  if (/SITE_BLOCKED|RATE_LIMITED|bot wall|fresh browser needed/i.test(reason)) return;
  const folder = siteDir(siteName(site));
  await mkdir(folder, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), name, way, reason }) + "\n";
  await appendFile(join(folder, "heal.jsonl"), line, "utf8");
  await markHealPending(site, name, way, reason);
}

/** Every ability's heal state for a site: what drifted and the last repair. Empty when none. */
export async function readHealState(site: string): Promise<HealState> {
  try {
    const parsed = JSON.parse(await readFile(statePath(site), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as HealState)
      : {};
  } catch {
    return {};
  }
}

/** Remembers the first drift seen since the last repair. Later drifts do not replace it. */
export async function markHealPending(
  site: string,
  name: string,
  way: string,
  reason: string,
): Promise<void> {
  const state = await readHealState(site);
  const entry = state[name] ?? {};
  if (entry.pending) return;
  state[name] = {
    ...entry,
    pending: { way, reason: reason.slice(0, 300), at: new Date().toISOString() },
  };
  await writeState(site, state);
}

export async function pendingHeal(site: string, name: string): Promise<PendingHeal | undefined> {
  return (await readHealState(site))[name]?.pending;
}

/** Records a repair and clears the drift it answered. The receipt is new, so not yet announced. */
export async function settleHeal(site: string, name: string, receipt: HealReceipt): Promise<void> {
  const state = await readHealState(site);
  state[name] = { last: receipt };
  await writeState(site, state);
}

/** The ability's last repair, whether or not it was announced. */
export async function lastHeal(site: string, name: string): Promise<HealReceipt | undefined> {
  return (await readHealState(site))[name]?.last;
}

/** The last repair, once: the first run after a repair returns it, later runs do not. */
export async function takeHealReceipt(
  site: string,
  name: string,
): Promise<HealReceipt | undefined> {
  const state = await readHealState(site);
  const entry = state[name];
  if (!entry?.last || entry.announced) return undefined;
  state[name] = { ...entry, announced: true };
  await writeState(site, state);
  return entry.last;
}

/** The one-line proof: `Repaired search (v1 → v2)`. */
export function healLine(
  name: string,
  receipt: Pick<HealReceipt, "fromVersion" | "toVersion">,
): string {
  return `Repaired ${name} (v${receipt.fromVersion} → v${receipt.toVersion})`;
}

function statePath(site: string): string {
  return join(siteDir(siteName(site)), STATE_FILE);
}

async function writeState(site: string, state: HealState): Promise<void> {
  await mkdir(siteDir(siteName(site)), { recursive: true });
  await writeAtomic(statePath(site), JSON.stringify(state, null, 2) + "\n");
}

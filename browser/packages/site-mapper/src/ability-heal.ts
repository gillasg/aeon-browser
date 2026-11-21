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
  await appendHealLog(site, { event: "drift", name, way, reason });
  await markHealPending(site, name, way, reason);
}

/** One line of `heal.jsonl`: a drift, a repair attempt, its outcome, or a version change. */
export interface HealLogEntry {
  at: string;
  name: string;
  event: "drift" | "attempt" | "repaired" | "unrepaired" | "not-drift" | "ok";
  way?: string;
  reason?: string;
  /** Operations of the site model that were failing and passed to the repair. */
  operations?: string[];
  fromVersion?: number;
  toVersion?: number;
}

const LOG_FILE = "heal.jsonl";
/** Lines kept per site. The oldest go first, so a long-lived install stays small. */
export const HEAL_LOG_LIMIT = 500;
const logWrites = new Map<string, Promise<unknown>>();

/**
 * Appends one entry. Writes for a site are serialised; each line is capped and written whole, and
 * when the file passes the limit it is rewritten atomically with the newest lines only.
 */
export function appendHealLog(
  site: string,
  entry: Omit<HealLogEntry, "at"> & { at?: string },
): Promise<void> {
  const key = siteName(site);
  const previous = logWrites.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => appendUnlocked(key, entry));
  logWrites.set(key, next);
  return next;
}

async function appendUnlocked(
  site: string,
  entry: Omit<HealLogEntry, "at"> & { at?: string },
): Promise<void> {
  const folder = siteDir(site);
  await mkdir(folder, { recursive: true });
  const record: HealLogEntry = {
    ...entry,
    at: entry.at ?? new Date().toISOString(),
    ...(entry.reason ? { reason: entry.reason.slice(0, 300) } : {}),
    ...(entry.operations ? { operations: entry.operations.slice(0, 50) } : {}),
  };
  const line = JSON.stringify(record);
  await appendFile(join(folder, LOG_FILE), line + "\n", "utf8");
  const lines = await logLines(site);
  if (lines.length > HEAL_LOG_LIMIT)
    await writeAtomic(join(folder, LOG_FILE), lines.slice(-HEAL_LOG_LIMIT).join("\n") + "\n");
}

async function logLines(site: string): Promise<string[]> {
  const text = await readFile(join(siteDir(siteName(site)), LOG_FILE), "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim());
}

/** Self-heal history, oldest first. A torn or foreign line is skipped, never thrown. */
export async function readHealLog(
  site: string,
  options: { name?: string; limit?: number } = {},
): Promise<HealLogEntry[]> {
  const entries: HealLogEntry[] = [];
  for (const line of await logLines(site)) {
    try {
      const value = JSON.parse(line) as Partial<HealLogEntry> & { event?: string };
      if (!value || typeof value.name !== "string" || typeof value.at !== "string") continue;
      // Lines from before the event field were drifts.
      const entry = { ...value, event: value.event ?? "drift" } as HealLogEntry;
      if (!options.name || entry.name === options.name) entries.push(entry);
    } catch {
      continue;
    }
  }
  return options.limit ? entries.slice(-options.limit) : entries;
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

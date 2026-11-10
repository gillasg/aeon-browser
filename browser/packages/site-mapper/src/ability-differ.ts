// Now and then a read is run through a second way. The page (or the other way) is the oracle
// for an API way: rows it saw must show up in the API result. A disagreement marks the ability
// stale. The caller's result is still the way that ran first.

import type { AbilityStats, AbilityWay } from "./abilities.js";
import { rowsOf } from "./ability-records.js";
import type { WayNote } from "./ability-stats.js";
import { wayId } from "./ability-stats.js";

export interface DifferResult {
  compared: boolean;
  stale: boolean;
  why?: string;
  notes: WayNote[];
}

/** Every eighth run, or when the caller asks. The first run is never the check. */
export function shouldDiffer(stats: AbilityStats, force: boolean | undefined): boolean {
  if (force) return true;
  const runs = stats.runs + 1;
  return runs > 1 && runs % 8 === 0;
}

/** The other way to compare. An API way prefers a page way as its oracle. */
export function oracleFor(ways: AbilityWay[], used: AbilityWay): AbilityWay | undefined {
  const others = ways.filter((way) => wayId(way) !== wayId(used));
  if (!others.length) return undefined;
  if (used.kind !== "api") return others[0];
  return others.find((way) => way.kind === "page" || pageScript(way)) ?? others[0];
}

function pageScript(way: AbilityWay): boolean {
  return way.kind === "script" && way.runtime === "page";
}

export async function compareWays(
  used: AbilityWay,
  other: AbilityWay,
  subject: unknown,
  run: (way: AbilityWay) => Promise<unknown>,
): Promise<DifferResult> {
  const started = Date.now();
  try {
    const result = await run(other);
    const verdict = waysAgree(subject, used, result, other);
    return {
      compared: true,
      stale: !verdict.ok,
      ...(verdict.why ? { why: verdict.why } : {}),
      notes: [{ way: other, ok: true, ms: Date.now() - started }],
    };
  } catch {
    return {
      compared: false,
      stale: false,
      notes: [{ way: other, ok: false, ms: Date.now() - started }],
    };
  }
}

export function waysAgree(
  left: unknown,
  leftWay: AbilityWay,
  right: unknown,
  rightWay: AbilityWay,
): { ok: boolean; why?: string } {
  if (leftWay.kind === "api" && rightWay.kind !== "api") return includesOracle(left, right);
  if (rightWay.kind === "api" && leftWay.kind !== "api") return includesOracle(right, left);
  if (JSON.stringify(left) === JSON.stringify(right)) return { ok: true };
  return { ok: false, why: "the two ways returned different results" };
}

/** Oracle rows (the page) must appear in the API result. Extra API rows are fine. */
function includesOracle(api: unknown, oracle: unknown): { ok: boolean; why?: string } {
  const apiRows = rowsOf(api);
  const oracleRows = rowsOf(oracle);
  if (apiRows && oracleRows) return rowsCovered(apiRows, oracleRows);
  const oracleText = JSON.stringify(oracle);
  const apiText = JSON.stringify(api);
  if (apiText === oracleText || (oracleText.length > 2 && apiText.includes(oracleText)))
    return { ok: true };
  return { ok: false, why: "the two ways returned different results" };
}

function rowsCovered(apiRows: unknown[], oracleRows: unknown[]): { ok: boolean; why?: string } {
  if (!oracleRows.length) return { ok: true };
  const missing = oracleRows
    .slice(0, 5)
    .filter((row) => !apiRows.some((item) => sameRecord(item, row))).length;
  if (!missing) return { ok: true };
  return { ok: false, why: `${missing} row(s) from the other way are missing` };
}

function sameRecord(api: unknown, oracle: unknown): boolean {
  if (JSON.stringify(api) === JSON.stringify(oracle)) return true;
  if (!api || !oracle || typeof api !== "object" || typeof oracle !== "object") return false;
  const keys = primitiveKeys(oracle as Record<string, unknown>);
  if (!keys.length) return false;
  const left = api as Record<string, unknown>;
  const right = oracle as Record<string, unknown>;
  return keys.every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

function primitiveKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).filter(
    (key) => record[key] === null || typeof record[key] !== "object",
  );
}

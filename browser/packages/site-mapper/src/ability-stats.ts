// Per-way success and latency. A way's id is its kind plus a hash of its definition, so editing
// the way starts a fresh record. Reads try the way that succeeded most recently, then stored
// order. Three failures in a row with no success since wait out a doubling delay, capped at a week.

import { createHash } from "node:crypto";
import type { Ability, AbilityStats, AbilityVia, AbilityWay } from "./abilities.js";

export interface AbilityWayStats {
  runs: number;
  /** Consecutive failures since the last success. */
  failures: number;
  lastOkAt?: string;
  /** Median latency of recent successes, in milliseconds. */
  p50Ms?: number;
  /** Recent successful durations used to recompute p50. Capped. */
  samplesMs?: number[];
  /** Not tried again until this time, after three failures in a row. */
  retryAt?: string;
}

export interface WayNote {
  way: AbilityWay;
  ok: boolean;
  ms: number;
}

export interface WayOrder {
  ways: AbilityWay[];
  held: { via: AbilityVia; error: string }[];
}

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const SAMPLES = 11;

export function wayId(way: AbilityWay): string {
  const hash = createHash("sha256").update(stableJson(way)).digest("hex").slice(0, 12);
  return `${way.kind}:${hash}`;
}

export function inBackoff(stats: AbilityWayStats | undefined, now: number): boolean {
  if (!stats || stats.failures < 3 || !stats.retryAt) return false;
  return Date.parse(stats.retryAt) > now;
}

/** Last success first, then stored order. A way in backoff is held back unless the caller named its kind. */
export function orderWays(ability: Ability, now = Date.now(), via?: AbilityVia): WayOrder {
  const held: WayOrder["held"] = [];
  const ready: { way: AbilityWay; index: number; ok: number }[] = [];
  ability.ways.forEach((way, index) => classifyWay(ability, way, index, now, via, held, ready));
  ready.sort((left, right) => right.ok - left.ok || left.index - right.index);
  return { ways: ready.map((item) => item.way), held };
}

function classifyWay(
  ability: Ability,
  way: AbilityWay,
  index: number,
  now: number,
  via: AbilityVia | undefined,
  held: WayOrder["held"],
  ready: { way: AbilityWay; index: number; ok: number }[],
): void {
  const stats = ability.stats?.ways?.[wayId(way)];
  if (inBackoff(stats, now) && way.kind !== via) {
    held.push({
      via: way.kind,
      error: `skipped until ${stats?.retryAt} after ${stats?.failures} failures`,
    });
    return;
  }
  ready.push({ way, index, ok: stats?.lastOkAt ? Date.parse(stats.lastOkAt) : 0 });
}

export function withRunStats(
  stats: AbilityStats,
  ok: boolean,
  notes: WayNote[],
  at: string,
  differ?: { compared: boolean; stale: boolean; why?: string },
): AbilityStats {
  return {
    runs: stats.runs + 1,
    failures: ok ? 0 : stats.failures + 1,
    ...(ok ? { lastOkAt: at } : stats.lastOkAt ? { lastOkAt: stats.lastOkAt } : {}),
    lastUsedAt: at,
    ...wayFields(applyNotes(stats.ways, notes, at)),
    ...staleFields(stats, differ, at),
  };
}

function wayFields(ways: Record<string, AbilityWayStats>): {
  ways?: Record<string, AbilityWayStats>;
} {
  return Object.keys(ways).length ? { ways } : {};
}

function applyNotes(
  current: Record<string, AbilityWayStats> | undefined,
  notes: WayNote[],
  at: string,
): Record<string, AbilityWayStats> {
  const ways = { ...(current ?? {}) };
  for (const note of notes) ways[wayId(note.way)] = nextWayStats(ways[wayId(note.way)], note, at);
  return ways;
}

function nextWayStats(
  current: AbilityWayStats | undefined,
  note: WayNote,
  at: string,
): AbilityWayStats {
  const failures = note.ok ? 0 : (current?.failures ?? 0) + 1;
  const samples = note.ok
    ? [...(current?.samplesMs ?? []), note.ms].slice(-SAMPLES)
    : current?.samplesMs;
  return {
    runs: (current?.runs ?? 0) + 1,
    failures,
    ...okFields(note.ok, at, current?.lastOkAt),
    ...latencyFields(samples, current?.p50Ms),
    ...retryFields(note.ok, failures, at),
  };
}

function okFields(ok: boolean, at: string, previous: string | undefined): { lastOkAt?: string } {
  if (ok) return { lastOkAt: at };
  return previous ? { lastOkAt: previous } : {};
}

function latencyFields(
  samples: number[] | undefined,
  previous: number | undefined,
): { samplesMs?: number[]; p50Ms?: number } {
  if (samples?.length) return { samplesMs: samples, p50Ms: median(samples) };
  return previous !== undefined ? { p50Ms: previous } : {};
}

function retryFields(ok: boolean, failures: number, at: string): { retryAt?: string } {
  if (ok || failures < 3) return {};
  return { retryAt: new Date(Date.parse(at) + retryDelay(failures)).toISOString() };
}

/** One hour after the third failure, then double, never more than a week. */
export function retryDelay(failures: number): number {
  const steps = Math.min(8, Math.max(0, failures - 3));
  return Math.min(WEEK, HOUR * 2 ** steps);
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  if (sorted.length % 2) return upper;
  const lower = sorted[mid - 1] ?? upper;
  return Math.round((lower + upper) / 2);
}

function staleFields(
  stats: AbilityStats,
  differ: { compared: boolean; stale: boolean; why?: string } | undefined,
  at: string,
): Pick<AbilityStats, "stale" | "staleWhy" | "lastDifferAt"> {
  if (!differ?.compared) return keptStale(stats);
  return {
    lastDifferAt: at,
    ...(differ.stale ? { stale: true, ...(differ.why ? { staleWhy: differ.why } : {}) } : {}),
  };
}

function keptStale(stats: AbilityStats): Pick<AbilityStats, "stale" | "staleWhy" | "lastDifferAt"> {
  return {
    ...(stats.stale ? { stale: true } : {}),
    ...(stats.staleWhy ? { staleWhy: stats.staleWhy } : {}),
    ...(stats.lastDifferAt ? { lastDifferAt: stats.lastDifferAt } : {}),
  };
}

/** Drops stats for ways the ability no longer has. */
export function liveWayStats(stats: AbilityStats, ways: AbilityWay[]): AbilityStats {
  if (!stats.ways) return stats;
  const ids = new Set(ways.map((way) => wayId(way)));
  const kept = Object.fromEntries(Object.entries(stats.ways).filter(([id]) => ids.has(id)));
  const next = { ...stats };
  delete next.ways;
  return Object.keys(kept).length ? { ...next, ways: kept } : next;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") return stableObject(value as Record<string, unknown>);
  return JSON.stringify(value) ?? "null";
}

function stableObject(record: Record<string, unknown>): string {
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

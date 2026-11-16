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
  /** The body shape this way answered with, learned from its verified answers. */
  shape?: Record<string, unknown>;
  /** JSON pointer to the list in that shape. */
  list?: string;
  shapeAt?: string;
  /** Verified answers the shape was learned from. */
  shapeSamples?: number;
  /** How many of those answers had each schema property, by pointer. */
  shapeSeen?: Record<string, number>;
  /** The answer no longer matched the recorded shape. The way is kept and still tried. */
  unverified?: boolean;
  unverifiedWhy?: string;
  unverifiedAt?: string;
}

export interface WayNote {
  way: AbilityWay;
  ok: boolean;
  ms: number;
  /** The answer's shape, recorded when the way has no declared expectation. */
  shape?: { shape: Record<string, unknown>; list?: string };
  /** The shape that no longer matched; the way is marked unverified, never removed. */
  unverified?: string;
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
  const ready: { way: AbilityWay; index: number; ok: number; verified: number }[] = [];
  ability.ways.forEach((way, index) => classifyWay(ability, way, index, now, via, held, ready));
  ready.sort(
    (left, right) =>
      right.verified - left.verified || right.ok - left.ok || left.index - right.index,
  );
  return { ways: ready.map((item) => item.way), held };
}

function classifyWay(
  ability: Ability,
  way: AbilityWay,
  index: number,
  now: number,
  via: AbilityVia | undefined,
  held: WayOrder["held"],
  ready: { way: AbilityWay; index: number; ok: number; verified: number }[],
): void {
  const stats = ability.stats?.ways?.[wayId(way)];
  if (inBackoff(stats, now) && way.kind !== via) {
    held.push({
      via: way.kind,
      error: `skipped until ${stats?.retryAt} after ${stats?.failures} failures`,
    });
    return;
  }
  ready.push({
    way,
    index,
    ok: stats?.lastOkAt ? Date.parse(stats.lastOkAt) : 0,
    verified: stats?.unverified ? 0 : 1,
  });
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
    ...shapeFields(note, current, at),
    ...verifyFields(note, at),
  };
}

/**
 * A way's verified answers record the shape later answers are accepted by. A field is required
 * only when it was present in every verified answer and there was more than one: one answer
 * cannot tell a required field from an optional one (pagination keys, sparse objects).
 */
function shapeFields(
  note: WayNote,
  current: AbilityWayStats | undefined,
  at: string,
): Pick<AbilityWayStats, "shape" | "list" | "shapeAt" | "shapeSamples" | "shapeSeen"> {
  if (!note.ok || !note.shape) return keptShape(current);
  if (current?.shape) return grownShape(current, note.shape.shape);
  const seen = presenceOf(note.shape.shape);
  return {
    shape: withPresence(note.shape.shape, seen, 1),
    ...(note.shape.list !== undefined ? { list: note.shape.list } : {}),
    shapeAt: at,
    shapeSamples: 1,
    shapeSeen: seen,
  };
}

type ShapeFields = Pick<
  AbilityWayStats,
  "shape" | "list" | "shapeAt" | "shapeSamples" | "shapeSeen"
>;

function keptShape(current: AbilityWayStats | undefined): ShapeFields {
  const kept: ShapeFields = {};
  if (current?.shape) kept.shape = current.shape;
  if (current?.list !== undefined) kept.list = current.list;
  if (current?.shapeAt) kept.shapeAt = current.shapeAt;
  if (current?.shapeSamples !== undefined) kept.shapeSamples = current.shapeSamples;
  if (current?.shapeSeen) kept.shapeSeen = current.shapeSeen;
  return kept;
}

function grownShape(current: AbilityWayStats, shape: Record<string, unknown>): ShapeFields {
  const seen = mergePresence(current.shapeSeen ?? presenceOf(current.shape ?? {}), shape);
  const samples = (current.shapeSamples ?? 1) + 1;
  return {
    shape: withPresence(current.shape as Record<string, unknown>, seen, samples),
    ...(current.list !== undefined ? { list: current.list } : {}),
    ...(current.shapeAt ? { shapeAt: current.shapeAt } : {}),
    shapeSamples: samples,
    shapeSeen: seen,
  };
}

interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  anyOf?: SchemaNode[];
  required?: string[];
}

/** The shape with `required` set only on fields present in every one of `samples` answers. */
function withPresence(
  shape: Record<string, unknown>,
  seen: Record<string, number>,
  samples: number,
): Record<string, unknown> {
  const next = structuredClone(shape) as SchemaNode;
  markRequired(next, "", seen, samples);
  return next as Record<string, unknown>;
}

function markRequired(
  schema: SchemaNode,
  pointer: string,
  seen: Record<string, number>,
  samples: number,
): void {
  if (schema.properties) {
    const required = Object.keys(schema.properties).filter(
      (key) => samples > 1 && seen[propertyPointer(pointer, key)] === samples,
    );
    if (required.length) schema.required = required;
    else delete schema.required;
    for (const [key, child] of Object.entries(schema.properties))
      markRequired(child, propertyPointer(pointer, key), seen, samples);
  }
  if (schema.items) markRequired(schema.items, pointer, seen, samples);
  for (const child of schema.anyOf ?? []) markRequired(child, pointer, seen, samples);
}

/** Every property pointer a schema declares, with array items sharing their array's pointer. */
function schemaPointers(shape: Record<string, unknown>): string[] {
  const out: string[] = [];
  collectPointers(shape as SchemaNode, "", out);
  return out;
}

function collectPointers(schema: SchemaNode, pointer: string, out: string[]): void {
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const next = propertyPointer(pointer, key);
    out.push(next);
    collectPointers(child, next, out);
  }
  if (schema.items) collectPointers(schema.items, pointer, out);
  for (const child of schema.anyOf ?? []) collectPointers(child, pointer, out);
}

function propertyPointer(pointer: string, key: string): string {
  return `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function presenceOf(shape: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(schemaPointers(shape).map((pointer) => [pointer, 1]));
}

/** Adds one verified answer to the counts, ignoring fields the learned shape does not know. */
function mergePresence(
  seen: Record<string, number>,
  shape: Record<string, unknown>,
): Record<string, number> {
  const next = { ...seen };
  for (const pointer of schemaPointers(shape))
    if (pointer in next) next[pointer] = (next[pointer] ?? 0) + 1;
  return next;
}

function verifyFields(
  note: WayNote,
  at: string,
): Pick<AbilityWayStats, "unverified" | "unverifiedWhy" | "unverifiedAt"> {
  if (!note.unverified) return {};
  return { unverified: true, unverifiedWhy: note.unverified, unverifiedAt: at };
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

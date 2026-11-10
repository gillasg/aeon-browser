// Runs an ability's ways. Reads are ordered by per-way stats (last success first, then stored
// order) and a way with three failures in a row waits out its retry. Writes stay in stored order
// and stop after a way may have committed. The caller records stats.

import { attemptWay, fill } from "./ability-attempt.js";
import { compareWays, oracleFor, shouldDiffer, type DifferResult } from "./ability-differ.js";
import { contractGap, isPartial, readBackOf } from "./ability-guard.js";
import { needsError } from "./ability-needs.js";
import {
  assertInputsApplied,
  pageRows,
  readRecords,
  rowsOf,
  usesRecordRuntime,
  type AbilityPage,
} from "./ability-records.js";
import { inBackoff, orderWays, wayId, type WayNote } from "./ability-stats.js";
import {
  AbilityWriteError,
  answerRepeat,
  classifyFailure,
  findWriteKey,
  readBack,
  recordWriteKey,
  writeKey,
  type WriteOutcome,
} from "./ability-writes.js";
import type {
  Ability,
  AbilityHost,
  AbilityRunOptions,
  AbilityRunResult,
  AbilityVia,
  AbilityWay,
} from "./abilities.js";
import { RecipeError } from "./runtime/recipe.js";

export type RunRecorder = (ok: boolean, notes: WayNote[], differ?: DifferResult) => Promise<void>;

interface TrackedRun {
  result: unknown;
  via: AbilityVia;
  tried: { via: AbilityVia; error: string }[];
  notes: WayNote[];
  partial?: boolean;
}

export async function executeRead(
  ability: Ability,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  options: AbilityRunOptions,
  record?: RunRecorder,
): Promise<AbilityRunResult> {
  const run = await runRead(ability, inputs, host, options, record);
  try {
    assertInputsApplied(ability, inputs, run.result);
  } catch (error) {
    if (record) await record(false, rejected(run.notes));
    throw error;
  }
  const differ = record ? await maybeDiffer(ability, inputs, host, run, options) : undefined;
  if (record) await record(true, [...run.notes, ...(differ?.notes ?? [])], differ);
  return publicRead(ability, run, options, differ);
}

function rejected(notes: WayNote[]): WayNote[] {
  return notes.map((note) => (note.ok ? { ...note, ok: false } : note));
}

export async function executeWrite(
  ability: Ability,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  options: AbilityRunOptions,
  record: RunRecorder,
): Promise<AbilityRunResult> {
  const key = writeKey(ability, inputs, options.key);
  const repeat = await repeatedWrite(ability, key);
  if (repeat) return repeat;
  return runWrite(ability, inputs, host, options, key, record);
}

async function runRead(
  ability: Ability,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  options: AbilityRunOptions,
  record: RunRecorder | undefined,
): Promise<TrackedRun> {
  const ranked = orderWays(ability, Date.now(), options.via);
  const tried = [...ranked.held];
  const notes: WayNote[] = [];
  let ways = ranked.ways;
  if (usesRecordRuntime(ability) && options.via !== "script") {
    const recorded = await runRecordWays({ ...ability, ways }, inputs, host, options, tried, notes);
    if (recorded && "run" in recorded) return recorded.run;
    ways = recorded ? unseen(ways, notes) : nodeScripts(ways);
  }
  return runWayList(ability, ways, inputs, host, options, tried, notes, record);
}

function nodeScripts(ways: AbilityWay[]): AbilityWay[] {
  return ways.filter((way) => way.kind === "script" && way.runtime === "node");
}

function unseen(ways: AbilityWay[], notes: WayNote[]): AbilityWay[] {
  const seen = new Set(notes.map((note) => wayId(note.way)));
  return ways.filter((way) => !seen.has(wayId(way)));
}

async function runWayList(
  ability: Ability,
  ways: AbilityWay[],
  inputs: Record<string, unknown>,
  host: AbilityHost,
  options: AbilityRunOptions,
  tried: TrackedRun["tried"],
  notes: WayNote[],
  record: RunRecorder | undefined,
): Promise<TrackedRun> {
  for (const way of ways) {
    const hit = await oneWay(ability, way, inputs, host, options, tried, notes);
    if (hit) return { ...hit, tried, notes };
  }
  if (record) await record(false, notes);
  throw new Error(`ABILITY_FAILED: ${ability.site} ${ability.name} (${triedText(tried)})`);
}

async function oneWay(
  ability: Ability,
  way: AbilityWay,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  options: AbilityRunOptions,
  tried: TrackedRun["tried"],
  notes: WayNote[],
): Promise<Pick<TrackedRun, "result" | "via" | "partial"> | undefined> {
  if (options.via && way.kind !== options.via) return undefined;
  if (way.partial && options.complete) {
    tried.push({ via: way.kind, error: "partial way skipped; caller asked for the full result" });
    return undefined;
  }
  const unmet = needsError(way, host);
  if (unmet) {
    tried.push({ via: way.kind, error: unmet });
    return undefined;
  }
  return finishWay(ability, way, inputs, host, options, tried, notes);
}

async function finishWay(
  ability: Ability,
  way: AbilityWay,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  options: AbilityRunOptions,
  tried: TrackedRun["tried"],
  notes: WayNote[],
): Promise<Pick<TrackedRun, "result" | "via" | "partial"> | undefined> {
  const started = Date.now();
  try {
    const result = await attemptWay(ability, way, inputs, host);
    return judged(ability, way, result, Date.now() - started, options, tried, notes);
  } catch (error) {
    notes.push({ way, ok: false, ms: Date.now() - started });
    tried.push({ via: way.kind, error: messageOf(error) });
    return undefined;
  }
}

function judged(
  ability: Ability,
  way: AbilityWay,
  result: unknown,
  ms: number,
  options: AbilityRunOptions,
  tried: TrackedRun["tried"],
  notes: WayNote[],
): Pick<TrackedRun, "result" | "via" | "partial"> | undefined {
  const gap = contractGap(ability, result);
  if (gap) return noteSkip(way, `contract: ${gap}`, ms, false, tried, notes);
  const partial = isPartial(way, result);
  if (partial && options.complete)
    return noteSkip(
      way,
      "partial result skipped; caller asked for the full result",
      ms,
      true,
      tried,
      notes,
    );
  notes.push({ way, ok: true, ms });
  return { result, via: way.kind, ...(partial ? { partial: true } : {}) };
}

function noteSkip(
  way: AbilityWay,
  error: string,
  ms: number,
  ok: boolean,
  tried: TrackedRun["tried"],
  notes: WayNote[],
): undefined {
  notes.push({ way, ok, ms });
  tried.push({ via: way.kind, error });
  return undefined;
}

async function runRecordWays(
  ability: Ability,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  options: AbilityRunOptions,
  tried: TrackedRun["tried"],
  notes: WayNote[],
): Promise<{ run: TrackedRun } | { rejected: true } | undefined> {
  const started = Date.now();
  try {
    const read = await readRecords(ability, inputs, host, wantedRows(options));
    noteFailures(ability.ways, read.failures, tried, notes);
    return judgedRecord(
      ability,
      read.via,
      read.result,
      Date.now() - started,
      options,
      tried,
      notes,
    );
  } catch (error) {
    noteRecordError(ability.ways, error, tried, notes);
    return undefined;
  }
}

function judgedRecord(
  ability: Ability,
  via: AbilityVia,
  result: unknown,
  ms: number,
  options: AbilityRunOptions,
  tried: TrackedRun["tried"],
  notes: WayNote[],
): { run: TrackedRun } | { rejected: true } | undefined {
  const way = winningWay(ability.ways, via, notes);
  if (!way) return undefined;
  const judgedWay = judged(ability, way, result, ms, options, tried, notes);
  if (!judgedWay) return { rejected: true };
  return { run: { ...judgedWay, tried, notes } };
}

function winningWay(ways: AbilityWay[], via: AbilityVia, notes: WayNote[]): AbilityWay | undefined {
  const failed = new Set(notes.filter((note) => !note.ok).map((note) => wayId(note.way)));
  return (
    ways.find((way) => way.kind === via && !failed.has(wayId(way))) ??
    ways.find((way) => way.kind === via)
  );
}

function noteFailures(
  ways: AbilityWay[],
  failures: { via: AbilityVia; error: string }[],
  tried: TrackedRun["tried"],
  notes: WayNote[],
): void {
  const pool = [...ways];
  for (const failure of failures) {
    tried.push(failure);
    const index = pool.findIndex((way) => way.kind === failure.via);
    const way = index >= 0 ? pool.splice(index, 1)[0] : undefined;
    if (way) notes.push({ way, ok: false, ms: 0 });
  }
}

function noteRecordError(
  ways: AbilityWay[],
  error: unknown,
  tried: TrackedRun["tried"],
  notes: WayNote[],
): void {
  if (error instanceof RecipeError) {
    noteFailures(
      ways,
      error.attempts.map((attempt) => ({
        via: viaFromStrategy(attempt.strategy),
        error: attempt.error ?? "failed",
      })),
      tried,
      notes,
    );
    return;
  }
  tried.push({ via: "api", error: messageOf(error) });
}

function viaFromStrategy(strategy: string): AbilityVia {
  if (strategy === "collect") return "page";
  if (strategy === "workflow") return "steps";
  if (strategy === "script") return "script";
  return "api";
}

async function maybeDiffer(
  ability: Ability,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  run: TrackedRun,
  options: AbilityRunOptions,
): Promise<DifferResult | undefined> {
  const stats = ability.stats ?? { runs: 0, failures: 0 };
  if (!shouldDiffer(stats, options.differ)) return undefined;
  const used = run.notes.find((note) => note.ok)?.way;
  const other = used ? oracleFor(ability.ways, used) : undefined;
  if (!used || !other || inBackoff(stats.ways?.[wayId(other)], Date.now())) return undefined;
  if (needsError(other, host)) return undefined;
  return compareWays(used, other, run.result, (way) => attemptWay(ability, way, inputs, host));
}

function publicRead(
  ability: Ability,
  run: TrackedRun,
  options: AbilityRunOptions,
  differ: DifferResult | undefined,
): AbilityRunResult {
  const result = paged(ability, run.result, options);
  return {
    result,
    via: run.via,
    tried: run.tried,
    ...(run.partial ? { partial: true } : {}),
    ...(differ?.stale ? { stale: true, ...(differ.why ? { staleWhy: differ.why } : {}) } : {}),
  };
}

function paged(ability: Ability, result: unknown, options: AbilityRunOptions): unknown {
  if (options.limit === undefined && options.cursor === undefined) return result;
  return pageOf(ability, result, options);
}

function pageOf(ability: Ability, result: unknown, options: AbilityRunOptions): AbilityPage {
  const key = (ability.options.recordMapping as { key?: string } | undefined)?.key;
  return pageRows(rowsOf(result) ?? [result], {
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(key ? { key } : {}),
  });
}

function wantedRows(options: AbilityRunOptions): number | undefined {
  if (options.limit === undefined || options.cursor) return undefined;
  return options.limit + 1;
}

/**
 * A write tries its ways in stored order only while nothing may have applied: once a way fails
 * after its commit step started, the runner stops instead of trying another way.
 */
async function runWrite(
  ability: Ability,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  options: AbilityRunOptions,
  key: string | undefined,
  record: RunRecorder,
): Promise<AbilityRunResult> {
  const tried: TrackedRun["tried"] = [];
  const notes: WayNote[] = [];
  let last: WriteOutcome | undefined;
  for (const way of ability.ways) {
    const hit = await oneWrite(ability, way, inputs, host, options, tried, notes);
    if (hit.done) return appliedWrite(ability, inputs, host, hit.run, tried, key, notes, record);
    if (hit.outcome) last = hit.outcome;
    if (last?.possible_commit) break;
  }
  return failedWrite(ability, key, tried, notes, last, record);
}

async function oneWrite(
  ability: Ability,
  way: AbilityWay,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  options: AbilityRunOptions,
  tried: TrackedRun["tried"],
  notes: WayNote[],
): Promise<
  | { done: true; run: { result: unknown; via: AbilityVia } }
  | { done: false; outcome?: WriteOutcome }
> {
  if (options.via && way.kind !== options.via) return { done: false };
  const unmet = needsError(way, host);
  if (unmet) {
    tried.push({ via: way.kind, error: unmet });
    return { done: false };
  }
  return attemptWrite(ability, way, inputs, host, tried, notes);
}

async function attemptWrite(
  ability: Ability,
  way: AbilityWay,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  tried: TrackedRun["tried"],
  notes: WayNote[],
): Promise<
  { done: true; run: { result: unknown; via: AbilityVia } } | { done: false; outcome: WriteOutcome }
> {
  const progress = { reachedCommit: way.kind !== "api" };
  const started = Date.now();
  try {
    const result = await attemptWay(ability, way, inputs, host, progress);
    notes.push({ way, ok: true, ms: Date.now() - started });
    return { done: true, run: { result, via: way.kind } };
  } catch (error) {
    notes.push({ way, ok: false, ms: Date.now() - started });
    tried.push({ via: way.kind, error: messageOf(error) });
    return { done: false, outcome: classifyFailure(error, progress.reachedCommit) };
  }
}

async function repeatedWrite(
  ability: Ability,
  key: string | undefined,
): Promise<AbilityRunResult | undefined> {
  const entry = key ? await findWriteKey(ability, key) : undefined;
  const repeat = key && entry ? answerRepeat(ability, key, entry) : undefined;
  if (!repeat || !key) return undefined;
  return {
    result: repeat.result,
    via: "api",
    tried: [],
    write: { write_status: "applied", key, replayed: true },
  };
}

async function appliedWrite(
  ability: Ability,
  inputs: Record<string, unknown>,
  host: AbilityHost,
  run: { result: unknown; via: AbilityVia },
  tried: TrackedRun["tried"],
  key: string | undefined,
  notes: WayNote[],
  record: RunRecorder,
): Promise<AbilityRunResult> {
  if (key) await recordWriteKey(ability, key, { write_status: "applied", result: run.result });
  await record(true, notes);
  const check = await confirmWrite(ability, inputs, host);
  return {
    result: run.result,
    via: run.via,
    tried,
    write: { write_status: "applied", possible_commit: true, ...(key ? { key } : {}) },
    ...(check ? { readBack: { ok: check.ok, missing: check.missing } } : {}),
  };
}

async function confirmWrite(
  ability: Ability,
  inputs: Record<string, unknown>,
  host: AbilityHost,
): Promise<{ ok: boolean; missing: string[] } | undefined> {
  const rule = readBackOf(ability);
  if (!rule) return undefined;
  const check = await readBack(
    rule,
    inputs,
    (name, values) => readAbilityResult(ability, name, values, host),
    fill,
  );
  return { ok: check.ok, missing: check.missing };
}

async function readAbilityResult(
  ability: Ability,
  name: string,
  values: Record<string, unknown>,
  host: AbilityHost,
): Promise<unknown> {
  const { runAbility } = await import("./abilities.js");
  return (await runAbility(ability.site, name, values, { host })).result;
}

async function failedWrite(
  ability: Ability,
  key: string | undefined,
  tried: TrackedRun["tried"],
  notes: WayNote[],
  last: WriteOutcome | undefined,
  record: RunRecorder,
): Promise<never> {
  await record(false, notes);
  const outcome = last ?? failedOutcome();
  if (key && outcome.possible_commit)
    await recordWriteKey(ability, key, { write_status: "may_have_applied" });
  throw new AbilityWriteError(
    `ABILITY_FAILED: ${ability.site} ${ability.name} (${triedText(tried)})`,
    outcome,
  );
}

function failedOutcome(): WriteOutcome {
  return {
    code: "execution_failed",
    write_status: "not_attempted",
    possible_commit: false,
    retry: "same_key",
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function triedText(tried: { via: AbilityVia; error: string }[]): string {
  return tried.map((item) => `${item.via}: ${item.error}`).join("; ") || "no way matched";
}

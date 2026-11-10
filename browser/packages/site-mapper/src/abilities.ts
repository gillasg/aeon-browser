// One named thing doable on a site, read or write, with the ways to do it tried in order: the
// site's API, a replayed step list, code, or a page collector. Abilities replace the old recipe,
// action, workflow, skill and site-tool stores; site notes hold facts that are not callable.

import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { defaultHost } from "./ability-attempt.js";
import { executeRead, executeWrite, type RunRecorder } from "./ability-run.js";
import {
  contractBreaks,
  contractWarnings,
  testAbilityCases,
  unusedInputs,
  type AbilityTest,
  type AbilityTestReport,
} from "./ability-contract.js";
import type { DifferResult } from "./ability-differ.js";
import {
  preconditionError,
  type AbilityPostcondition,
  type AbilityPrecondition,
} from "./ability-guard.js";
import { proveSave, withSample, type AbilitySample } from "./ability-save-test.js";
import { liveWayStats, withRunStats, type AbilityWayStats, type WayNote } from "./ability-stats.js";
import { join } from "node:path";
import type { AbilityCheck } from "./ability-records.js";
import type { ReadBack, WriteOutcome } from "./ability-writes.js";
import { builtinAbilities, builtinWay } from "./builtin-abilities.js";
import { siteDir, siteName, writeAtomic } from "./registry.js";
import type { CollectRecipe, RecipePagination } from "./recipes.js";
import type { Json } from "./types.js";
export {
  acceptSiteNote,
  factsFromText,
  readSiteFacts,
  readSiteNotes,
  renderSiteNotes,
  saveSiteNote,
  writeSiteNotes,
  type SiteNote,
  type SiteNoteKind,
} from "./site-notes.js";

export type AbilityKind = "read" | "write";
export type AbilityCreatedBy = "agent" | "user" | "import" | "builtin";
export type AbilityVia = "api" | "steps" | "script" | "page";

export interface AbilityApiStep {
  operation: string;
  params?: Record<string, unknown>;
}

export interface AbilityWayApi {
  kind: "api";
  /** This way returns part of the contract (the visible page, not every row). */
  partial?: boolean;
  /** One operation. */
  operation?: string;
  /** A chain of operations; later steps may map values from inputs/earlier steps. */
  operations?: AbilityApiStep[];
  open?: string;
  params?: Record<string, unknown>;
  paging?: RecipePagination;
  records?: { find: { exists: string[] } };
  write?: Record<string, unknown>;
  input?: Json;
  /** Write abilities: index of the operation that applies the change (default: the last). */
  commit?: number;
}

export interface AbilityWaySteps {
  kind: "steps";
  /** This way returns part of the contract (the visible page, not every row). */
  partial?: boolean;
  /** A saved workflow definition, or its name for the host's workflow store. */
  workflow?: unknown;
  name?: string;
  params?: Record<string, unknown>;
  steps?: unknown[];
}

export interface AbilityWayScript {
  kind: "script";
  /** This way returns part of the contract (the visible page, not every row). */
  partial?: boolean;
  code: string;
  runtime: "node" | "page";
  input?: Json;
}

export interface AbilityWayPage {
  kind: "page";
  /** This way returns part of the contract (the visible page, not every row). */
  partial?: boolean;
  collect?: CollectRecipe;
  url?: string;
  extractor?: unknown;
}

export type AbilityWay = AbilityWayApi | AbilityWaySteps | AbilityWayScript | AbilityWayPage;

export interface AbilityOptions {
  paging?: RecipePagination;
  recordMapping?: Record<string, unknown>;
  dryRun?: boolean;
  /** Rules a read's rows must satisfy when the caller passed the input. */
  checks?: AbilityCheck[];
  /** Write abilities: a read run afterwards to confirm the change. */
  readBack?: ReadBack;
  /** Old fields with no dedicated home live here (write receipts, render, thread, derive…). */
  [key: string]: unknown;
}

export interface AbilityStats {
  runs: number;
  failures: number;
  lastOkAt?: string;
  lastUsedAt?: string;
  /** Keyed by way id (`kind` plus a hash of the way). Absent means stored order. */
  ways?: Record<string, AbilityWayStats>;
  /** A second way disagreed with the one that served the result. */
  stale?: boolean;
  staleWhy?: string;
  lastDifferAt?: string;
}

export type { AbilityPostcondition, AbilityPrecondition, AbilityWayStats };

export interface Ability {
  name: string;
  site: string;
  description?: string;
  kind: AbilityKind;
  inputs: Record<string, unknown>;
  /** JSON Schema of the result (its properties are the fields callers may rely on). */
  outputs?: Record<string, unknown>;
  ways: AbilityWay[];
  /** Cases `testAbility` runs: inputs and values the result must contain. */
  tests?: AbilityTest[];
  /** What must be true before a run, checked when the host can answer. */
  preconditions?: AbilityPrecondition;
  /** Writes: the read-back that confirms the change. `options.readBack` still works. */
  postcondition?: AbilityPostcondition;
  options: AbilityOptions;
  stats: AbilityStats;
  createdBy: AbilityCreatedBy;
  /** The old store it came from: recipe, action, workflow, tool, pageTool, skill, pack. */
  sourceKind?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AbilityRunResult {
  result: unknown;
  via: AbilityVia;
  tried: { via: AbilityVia; error: string }[];
  /** Writes: how the call left the site, and the key it ran under. */
  write?: Partial<WriteOutcome> & { key?: string; replayed?: boolean };
  /** Writes with readBack: whether the site shows the change. */
  readBack?: { ok: boolean; missing: string[] };
  /** The way that ran only had part of the contract. */
  partial?: boolean;
  /** A second way disagreed; the ability is marked stale. */
  stale?: boolean;
  staleWhy?: string;
}

export interface AbilityRunOptions {
  via?: AbilityVia;
  host?: AbilityHost;
  /** Writes: the same key never applies twice (kept a day). */
  key?: string;
  /** Lists: rows per page; the result becomes {items, next_cursor, has_more}. */
  limit?: number;
  /** Lists: next_cursor from the previous page. */
  cursor?: string;
  /** Skip ways that only return part of the contract. */
  complete?: boolean;
  /** Also run a second way and compare. Reads do this on their own every eighth run. */
  differ?: boolean;
}

export interface AbilityHost {
  call?: (operation: string, params: Record<string, unknown>) => Promise<unknown>;
  write?: (operation: string, params: Record<string, unknown>) => Promise<unknown>;
  open?: (url: string) => Promise<void>;
  collect?: (input: CollectRecipe & { url?: string }) => Promise<unknown>;
  script?: (code: string, input: unknown) => Promise<unknown>;
  workflow?: (input: {
    name?: string;
    workflow?: unknown;
    inputs: Record<string, unknown>;
  }) => Promise<unknown>;
  resolveOperation?: (wanted: string) => string | undefined;
  /** When present, a precondition of `signedIn` is checked before the run. */
  signedIn?: () => Promise<boolean>;
  /** When present, a precondition of `pageType` is checked before the run. */
  pageType?: () => Promise<string | undefined>;
}

const ABILITIES = "abilities";
const TRASH = "trash";
const NAME = /^[a-z0-9][a-z0-9 _.-]{0,80}$/i;

export function abilityDirectory(site: string): string {
  return join(siteDir(siteName(site)), ABILITIES);
}

export function abilitySlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export async function listAbilities(site: string): Promise<Ability[]> {
  const folder = abilityDirectory(site);
  const files = (await readdir(folder).catch(() => [] as string[])).filter((file) =>
    file.endsWith(".json"),
  );
  const abilities = (
    await Promise.all(files.map((file) => readAbilityFile(join(folder, file))))
  ).filter((ability): ability is Ability => !!ability);
  // Built-in abilities come with Aeon; a stored one of the same name replaces it.
  const stored = new Set(abilities.map((ability) => ability.name));
  return [
    ...abilities,
    ...builtinAbilities(site).filter((ability) => !stored.has(ability.name)),
  ].sort((left, right) => left.name.localeCompare(right.name));
}

export async function readAbility(site: string, name: string): Promise<Ability | undefined> {
  const direct = await readAbilityFile(join(abilityDirectory(site), abilitySlug(name) + ".json"));
  if (direct) return direct;
  return (await listAbilities(site)).find((ability) => ability.name === name);
}

async function readAbilityFile(path: string): Promise<Ability | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Ability;
    return value && typeof value.name === "string" && Array.isArray(value.ways) ? value : undefined;
  } catch {
    return undefined;
  }
}

export interface SaveAbilityOptions {
  replace?: boolean;
  /** Allow a replacement that drops or retypes an input, or drops an output field. */
  breaking?: boolean;
  /** Skip the caller-contract checks (run stats and migrations). */
  check?: boolean;
  /** Run stored cases with this host before writing. */
  host?: AbilityHost;
  /** Run stored cases with the default host before writing. */
  test?: boolean;
  /** Inputs and result from the run that produced this ability. Recorded as the first test when none were passed. */
  sample?: AbilitySample;
}

export async function saveAbility(
  ability: Ability,
  options: SaveAbilityOptions = {},
): Promise<{
  ability: Ability;
  path: string;
  warnings: string[];
  tests?: AbilityTestReport;
}> {
  const site = siteName(ability.site);
  const name = validAbilityName(ability.name);
  validateAbility({ ...ability, name, site });
  await mkdir(abilityDirectory(site), { recursive: true });
  const path = join(abilityDirectory(site), abilitySlug(name) + ".json");
  const existing = await readAbilityFile(path);
  if (existing && options.replace === false)
    throw new Error(`ABILITY_EXISTS: ${site} already has ${name}`);
  if (options.check !== false) checkContract(ability, existing, options);
  const drafted = withSample(
    {
      ...ability,
      name,
      site,
      stats: liveWayStats(ability.stats ?? { runs: 0, failures: 0 }, ability.ways),
      createdAt: ability.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    options.sample,
  );
  const tests = await proveOnSave(drafted, existing, options);
  const next = { ...drafted, updatedAt: new Date().toISOString() };
  await writeAtomic(path, JSON.stringify(next, null, 2) + "\n");
  return {
    ability: next,
    path,
    warnings: options.check === false ? [] : contractWarnings(next),
    ...(tests ? { tests } : {}),
  };
}

/** Runs cases before the write. A throw leaves the file, and its ways, untouched. */
async function proveOnSave(
  ability: Ability,
  existing: Ability | undefined,
  options: SaveAbilityOptions,
): Promise<AbilityTestReport | undefined> {
  if (options.check === false) return undefined;
  const host = options.host ?? (options.test ? defaultHost(ability.site) : undefined);
  if (!host) return undefined;
  return proveSave(ability, existing, (probe, inputs) => probeAbility(probe, inputs, host));
}

async function probeAbility(
  ability: Ability,
  inputs: Record<string, unknown>,
  host: AbilityHost,
): Promise<unknown> {
  return (await executeRead(ability, inputs, host, {})).result;
}

function checkContract(
  ability: Ability,
  existing: Ability | undefined,
  options: SaveAbilityOptions,
): void {
  if (ability.createdBy === "agent") {
    const unused = unusedInputs(ability);
    if (unused.length)
      throw new Error(
        `ABILITY_INPUT_UNUSED: ${ability.name} declares ${unused.join(", ")} but no way uses it; ` +
          'use it, drop it, or say "By design:" in its description',
      );
  }
  if (!existing || options.breaking) return;
  const breaks = contractBreaks(existing, ability);
  if (breaks.length)
    throw new Error(
      `ABILITY_CONTRACT_WEAKENED: ${ability.name}: ${breaks.join("; ")}. Callers rely on these; ` +
        "keep them, save under a new name, or pass breaking: true",
    );
}

export async function createAbility(
  ability: Omit<Ability, "name" | "site" | "stats" | "createdAt" | "updatedAt"> & {
    name: string;
    site: string;
  },
): Promise<{ ability: Ability; path: string; warnings: string[] }> {
  const base = validAbilityName(ability.name);
  let name = base;
  for (let index = 2; await readAbility(ability.site, name); index++) name = `${base}-${index}`;
  return saveAbility({
    ...ability,
    name,
    site: siteName(ability.site),
    stats: { runs: 0, failures: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

/** Moves an ability to trash/; nothing is hard-deleted. */
export async function trashAbility(
  site: string,
  name: string,
  reason = "maintenance",
): Promise<boolean> {
  const ability = await readAbility(site, name);
  if (!ability) return false;
  const folder = join(siteDir(siteName(site)), TRASH);
  await mkdir(folder, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(folder, `${abilitySlug(ability.name)}-${stamp}.json`);
  await writeAtomic(
    path,
    JSON.stringify({ ...ability, trashedAt: new Date().toISOString(), reason }, null, 2) + "\n",
  );
  await rename(
    join(abilityDirectory(site), abilitySlug(ability.name) + ".json"),
    join(abilityDirectory(site), "." + abilitySlug(ability.name) + "." + stamp + ".deleted"),
  );
  return true;
}

/**
 * Five failures in a row with no success in 14 days, or unused for 60 days, go to trash/.
 * A never-used ability is measured from its creation.
 */
export async function maintainAbilities(
  site: string,
  now = new Date(),
): Promise<{ trashed: string[] }> {
  const trashed: string[] = [];
  const day = 86_400_000;
  for (const ability of await listAbilities(site)) {
    const lastOk = ability.stats.lastOkAt ? Date.parse(ability.stats.lastOkAt) : undefined;
    const lastUsed = ability.stats.lastUsedAt
      ? Date.parse(ability.stats.lastUsedAt)
      : Date.parse(ability.createdAt);
    const failing =
      ability.stats.failures >= 5 && (lastOk === undefined || now.getTime() - lastOk > 14 * day);
    const unused = Number.isFinite(lastUsed) && now.getTime() - lastUsed > 60 * day;
    if (!failing && !unused) continue;
    if (await trashAbility(site, ability.name, failing ? "failing" : "unused"))
      trashed.push(ability.name);
  }
  return { trashed };
}

export async function runAbility(
  site: string,
  name: string,
  inputs: Record<string, unknown> = {},
  options: AbilityRunOptions = {},
): Promise<AbilityRunResult> {
  const ability = withBuiltinWay(await readAbility(site, name), inputs);
  if (!ability) throw new Error(`ABILITY_UNKNOWN: ${siteName(site)} has no ability ${name}`);
  const host = options.host ?? defaultHost(site);
  const blocked = await preconditionError(ability, host);
  if (blocked) throw new Error(blocked);
  const record: RunRecorder = (ok, notes, differ) => recordAbilityRun(ability, ok, notes, differ);
  if (ability.kind === "write") return executeWrite(ability, inputs, host, options, record);
  return executeRead(ability, inputs, host, options, record);
}

/** Runs an ability's stored test cases and reports failures and constant output. */
export async function testAbility(
  site: string,
  name: string,
  options: { host?: AbilityHost } = {},
): Promise<AbilityTestReport> {
  const ability = await readAbility(site, name);
  if (!ability) throw new Error(`ABILITY_UNKNOWN: ${siteName(site)} has no ability ${name}`);
  if (ability.kind === "write")
    throw new Error(`ABILITY_TEST_WRITE: ${name} writes; its cases would change the site`);
  return testAbilityCases(
    ability,
    async (inputs) =>
      (await runAbility(site, name, inputs, options.host ? { host: options.host } : {})).result,
  );
}

/** A built-in ability runs the code written for these inputs. */
export function withBuiltinWay(
  ability: Ability | undefined,
  inputs: Record<string, unknown>,
): Ability | undefined {
  if (ability?.createdBy !== "builtin") return ability;
  const way = builtinWay(ability.site, ability.name, inputs);
  return way ? { ...ability, ways: [way] } : ability;
}

async function recordAbilityRun(
  ability: Ability,
  ok: boolean,
  notes: WayNote[] = [],
  differ?: DifferResult,
): Promise<void> {
  // Built-in abilities are not stored: saving their stats would freeze a copy that shadows them.
  if (ability.createdBy === "builtin") return;
  const now = new Date().toISOString();
  const next: Ability = {
    ...ability,
    stats: withRunStats(ability.stats ?? { runs: 0, failures: 0 }, ok, notes, now, differ),
    updatedAt: now,
  };
  await saveAbility(next, { check: false });
}

function validAbilityName(name: string): string {
  if (!NAME.test(name.trim())) throw new Error(`INVALID_ABILITY_NAME: ${name}`);
  return name.trim();
}

function validateAbility(ability: Ability): void {
  if (!ability.ways.length) throw new Error(`ABILITY_NO_WAYS: ${ability.name}`);
  for (const way of ability.ways) {
    if (!["api", "steps", "script", "page"].includes(way.kind))
      throw new Error(`ABILITY_BAD_WAY: ${ability.name}`);
    if (way.kind === "script" && (!way.code || !["node", "page"].includes(way.runtime)))
      throw new Error(`ABILITY_BAD_SCRIPT: ${ability.name}`);
  }
}

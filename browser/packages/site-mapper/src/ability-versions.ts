// Keep the previous content of an ability on every real save. Stats and test records are not
// content, so an ordinary run does not create a version. History is capped per ability, and a
// restore goes back through the same caller-contract checks as any other save.

import { mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { scrubAbility } from "./ability-scrub.js";
import { basename, join } from "node:path";
import type { Ability } from "./abilities.js";
import { contentDigest } from "./ability-digest.js";
import { abilityHistoryDirectory } from "./ability-files.js";
import { writeAtomic } from "./registry.js";

/** Versions kept per ability. The cap bounds disk use on a long-lived install. */
export const ABILITY_HISTORY_LIMIT = 10;

export interface AbilityVersion {
  /** The version's id, also its file name without `.json`; pass it to `restoreAbility`. */
  at: string;
  updatedAt?: string;
  kind: "read" | "write";
  ways: string[];
  bytes: number;
}

/** File stamps sort as dates; `:` and `.` are not safe in every file system. */
export function versionStamp(iso = new Date().toISOString()): string {
  return iso.replace(/[:.]/g, "-");
}

/** Previous content, newest first. Each entry is one archived save. */
export async function listAbilityVersions(site: string, name: string): Promise<AbilityVersion[]> {
  const folder = abilityHistoryDirectory(site, name);
  const files = (await readdir(folder).catch(() => [] as string[]))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .reverse();
  const versions = await Promise.all(files.map((file) => readVersion(join(folder, file))));
  return versions.filter((version): version is AbilityVersion => !!version);
}

async function readVersion(path: string): Promise<AbilityVersion | undefined> {
  try {
    const at = basename(path, ".json");
    const file = await stat(path);
    const ability = JSON.parse(await readFile(path, "utf8")) as Ability;
    return {
      at,
      ...(ability.updatedAt ? { updatedAt: ability.updatedAt } : {}),
      kind: ability.kind === "write" ? "write" : "read",
      ways: (ability.ways ?? []).map((way) => way.kind),
      bytes: file.size,
    };
  } catch {
    return undefined;
  }
}

/** The version's content, when it is there and still parses. */
export async function readAbilityVersion(
  site: string,
  name: string,
  at: string,
): Promise<Ability | undefined> {
  try {
    const raw = await readFile(
      join(abilityHistoryDirectory(site, name), versionStamp(at) + ".json"),
      "utf8",
    );
    const value = JSON.parse(raw) as Ability;
    return value && typeof value.name === "string" && Array.isArray(value.ways)
      ? { ...value, options: value.options ?? {}, inputs: value.inputs ?? {} }
      : undefined;
  } catch {
    return undefined;
  }
}

/** A version file, named by its own stamp. */
const VERSION_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?\.json$/;

/**
 * How many earlier saves an ability has. The count comes from the directory entries: the library
 * asks for it on every render and a parse of every archived ability is not worth it.
 */
export async function countAbilityVersions(
  site: string,
  name: string,
): Promise<{ count: number; latestAt?: string }> {
  const files = (await readdir(abilityHistoryDirectory(site, name)).catch(() => [] as string[]))
    .filter((file) => VERSION_FILE.test(file))
    .sort();
  const latest = files.at(-1);
  return { count: files.length, ...(latest ? { latestAt: latest.slice(0, -".json".length) } : {}) };
}

/**
 * Archives the previous content of an ability when the new content differs. The archived copy is
 * scrubbed like any save, so a version never keeps a credential the live file no longer has.
 */
export async function versionChangedAbility(
  previous: Ability | undefined,
  next: Ability,
): Promise<string | undefined> {
  if (!previous || contentDigest(previous) === contentDigest(next)) return undefined;
  return saveAbilityVersion(scrubAbility(previous, undefined, { keepLast: true }).ability);
}

/** Writes one version and drops the oldest past the cap. */
export async function saveAbilityVersion(previous: Ability): Promise<string> {
  const folder = abilityHistoryDirectory(previous.site, previous.name);
  await mkdir(folder, { recursive: true });
  const at = await uniqueStamp(folder, versionStamp());
  await writeAtomic(join(folder, at + ".json"), JSON.stringify(previous, null, 2) + "\n");
  await pruneVersions(folder);
  return at;
}

/** Two saves in the same millisecond still get their own file. */
async function uniqueStamp(folder: string, stamp: string): Promise<string> {
  for (let copy = 1; ; copy++) {
    const wanted = copy === 1 ? stamp : `${stamp}-${copy}`;
    const exists = await stat(join(folder, wanted + ".json")).then(
      () => true,
      () => false,
    );
    if (!exists) return wanted;
  }
}

async function pruneVersions(folder: string): Promise<void> {
  const files = (await readdir(folder).catch(() => [] as string[]))
    .filter((file) => file.endsWith(".json"))
    .sort();
  for (const file of files.slice(0, Math.max(0, files.length - ABILITY_HISTORY_LIMIT)))
    await unlink(join(folder, file)).catch(() => undefined);
}

// One-time move of the old helper store (one JSON file per helper in a data folder) into the
// sites' `api.json` and `SKILL.md`. A moved file is renamed to `<name>.json.migrated`, never
// deleted, so nothing a user saved is lost. Old site notes move on first read (site-notes.ts).

import { readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { saveHelper, type SiteHelper } from "./site-helpers.js";

export const MIGRATED = ".migrated";

/** Moves every legacy helper file in `directory`. Returns the names moved. */
export async function migrateLegacyHelpers(directory: string | undefined): Promise<string[]> {
  if (!directory) return [];
  const files = (await readdir(directory).catch(() => [] as string[])).filter((file) =>
    file.endsWith(".json"),
  );
  const moved: string[] = [];
  for (const file of files) {
    const path = join(directory, file);
    const helper = await readLegacy(path);
    if (!helper) continue;
    try {
      // The user saved these before; they were never filtered, so they are not now.
      await saveHelper({ ...helper, enabled: helper.enabled !== false }, "user");
    } catch {
      continue;
    }
    await rename(path, path + MIGRATED).catch(() => undefined);
    moved.push(String(helper.name));
  }
  return moved;
}

async function readLegacy(path: string): Promise<Partial<SiteHelper> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<SiteHelper>;
    return value && typeof value.name === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

// Where an ability and its versions live. A leaf module so the version store can find an ability
// without importing the runner.

import { join } from "node:path";
import { siteDir, siteName } from "./registry.js";

const ABILITIES = "abilities";

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

/** Previous content of one ability, newest last on disk. */
export function abilityHistoryDirectory(site: string, name: string): string {
  return join(abilityDirectory(site), ".history", abilitySlug(name));
}

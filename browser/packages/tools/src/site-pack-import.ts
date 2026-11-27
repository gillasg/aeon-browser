import { resolve } from "node:path";
import { installSitePack, isSitePack, readSitePack } from "@browserkit/site-mapper";
import { assertSiteAllowed } from "./web-gate.js";

// site_mapper import of a site pack (a .zip from `graft pack export`, or the folder it was
// extracted into): the pack names its own site, so none is asked for. Its skills and boosts run in
// the user's browser and are left out here; `graft pack import` saves them disabled for review.

/** The packs among files (resolved in the workspace), or none when any file is not a pack. */
export async function sitePackPaths(files: string[], workspace: string): Promise<string[]> {
  const root = resolve(workspace);
  const paths = files.map((file) => resolve(root, file));
  if (!paths.length || paths.some((path) => !path.startsWith(root))) return [];
  const packs = await Promise.all(paths.map((path) => isSitePack(path)));
  return packs.every(Boolean) ? paths : [];
}

export async function importSitePacks(paths: string[]): Promise<unknown> {
  const imported = [];
  for (const path of paths) {
    const pack = await readSitePack(path);
    await assertSiteAllowed(pack.manifest.site);
    const installed = await installSitePack(pack);
    imported.push({
      site: installed.site,
      files: installed.written,
      ...(pack.skills.length || pack.boosts.length
        ? {
            skipped: `${pack.skills.length} skill(s) and ${pack.boosts.length} boost(s): the user imports those with graft pack import`,
          }
        : {}),
    });
  }
  return {
    imported,
    next: 'its saved abilities are ready: site_mapper({action:"ability", site}) lists them',
  };
}

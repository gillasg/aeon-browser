// Keeps `api.json` and the ops part of `SKILL.md` in step with the abilities on disk. Called after
// an ability is saved, restored or trashed. Loaded lazily: the compiler imports the ability
// runner, so a static import here would be a cycle.

/** Recompiles the site's ops. A failed refresh never fails the save; the next read compiles. */
export async function syncSiteOps(site: string): Promise<void> {
  try {
    const { compileSiteOps } = await import("./site-ops.js");
    await compileSiteOps(site);
  } catch {
    // api.json is derived; readSiteOps rebuilds it when missing.
  }
}

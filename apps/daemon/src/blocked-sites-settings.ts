import {
  addBlockedSite,
  readBlockedSites,
  removeBlockedSite,
  saveBlockedSites,
  siteName,
} from "@browserkit/tools/host";

// The one blocked-sites list, in browserkit's home (site-rules.json). The CLI and Settings both
// go through the daemon to it; agent code and tools never reach this module. `local` is the list
// an older Aeon kept in the extension: it is merged once, then the file is the only copy.

export interface BlockedSitesChange {
  action: "read" | "add" | "remove";
  site?: string | undefined;
  local?: string[] | undefined;
}

export async function applyBlockedSites(change: BlockedSitesChange): Promise<string[]> {
  if (change.action === "read") return mergeLocal(change.local);
  const site = siteName(change.site ?? "");
  if (!site) throw new Error(`Not a site: ${change.site ?? ""}`);
  const changed =
    change.action === "add" ? await addBlockedSite(site) : await removeBlockedSite(site);
  if (!changed) throw new Error(`Not a site: ${site}`);
  return readBlockedSites();
}

async function mergeLocal(local: string[] | undefined): Promise<string[]> {
  const current = await readBlockedSites();
  if (!local?.length) return current;
  const merged = [
    ...new Set([
      ...current,
      ...local.map((item) => siteName(item)).filter((item): item is string => Boolean(item)),
    ]),
  ].sort();
  if (merged.length !== current.length) await saveBlockedSites(merged);
  return merged;
}

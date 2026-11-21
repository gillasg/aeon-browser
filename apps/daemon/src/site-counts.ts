// Per-site counts for the cursor's X-Ray line: saved APIs are the mapped operations in the site
// registry, watches the routines that are on and name the site (or listen on one of its pages).
// Sites are compared the way the extension keys a page: host without www., port on loopback only.

export interface CountRoutine {
  enabled: boolean;
  deletedAt: string | null;
  sites: readonly string[];
  listen: { url: string } | null;
}

export interface SiteCount {
  site: string;
  apis: number;
  watches: number;
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

export function siteCountKey(value: string): string {
  const raw = value.trim().toLowerCase();
  if (!raw) return "";
  try {
    const url = new URL(/^[a-z]+:\/\//.test(raw) ? raw : "https://" + raw);
    const host = url.hostname.replace(/^www\./, "");
    return LOOPBACK.test(host) && url.port ? `${host}:${url.port}` : host;
  } catch {
    return raw;
  }
}

function routineSites(routine: CountRoutine): Set<string> {
  const keys = new Set(routine.sites.map(siteCountKey).filter(Boolean));
  if (routine.listen?.url) keys.add(siteCountKey(routine.listen.url));
  keys.delete("");
  return keys;
}

export function siteCounts(
  mapped: readonly { site: string; operations: number }[],
  routines: readonly CountRoutine[],
): SiteCount[] {
  const counts = new Map<string, SiteCount>();
  const row = (site: string): SiteCount => {
    const existing = counts.get(site);
    if (existing) return existing;
    const created = { site, apis: 0, watches: 0 };
    counts.set(site, created);
    return created;
  };
  for (const item of mapped) {
    const key = siteCountKey(item.site);
    if (key) row(key).apis += Math.max(0, item.operations);
  }
  for (const routine of routines) {
    if (!routine.enabled || routine.deletedAt) continue;
    for (const key of routineSites(routine)) row(key).watches += 1;
  }
  return [...counts.values()].filter((item) => item.apis || item.watches).slice(0, 500);
}

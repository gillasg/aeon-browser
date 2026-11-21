// What Aeon knows about a site, in one line: `4 APIs · 1 boost · 1 watch`. Every number comes
// from the site registry, the boost engine or the routines, never from a model. A count of 0 is
// left out, and with nothing to say there is no line at all.

export interface SiteCounts {
  apis: number;
  boosts: number;
  watches: number;
}

export interface XrayPart {
  count: number;
  noun: string;
}

const NOUNS: ReadonlyArray<[keyof SiteCounts, string, string]> = [
  ["apis", "API", "APIs"],
  ["boosts", "boost", "boosts"],
  ["watches", "watch", "watches"],
];

export function xrayParts(counts: Partial<SiteCounts> | undefined): XrayPart[] {
  if (!counts) return [];
  return NOUNS.flatMap(([key, one, many]) => {
    const count = Math.floor(Number(counts[key] ?? 0));
    return Number.isFinite(count) && count > 0 ? [{ count, noun: count === 1 ? one : many }] : [];
  });
}

export function xrayText(counts: Partial<SiteCounts> | undefined): string {
  return xrayParts(counts)
    .map((part) => `${part.count} ${part.noun}`)
    .join(" · ");
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/**
 * The registry key for a page: its host without `www.`, plus the port on loopback only, so two
 * local servers on different ports are two sites while `shop.com:443` stays `shop.com`.
 */
export function siteKey(url: string | undefined): string {
  if (!url) return "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  if (!/^https?:$/.test(parsed.protocol)) return "";
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  return LOOPBACK.test(host) && parsed.port ? `${host}:${parsed.port}` : host;
}

/** A registry site name in the same shape as siteKey, so the two compare. */
export function normalizeSite(site: string): string {
  const value = site.trim().toLowerCase();
  if (!value) return "";
  return /^[a-z]+:\/\//.test(value) ? siteKey(value) : siteKey("https://" + value) || value;
}

/** The counts for one page from the daemon's per-site list and the boost engine's count. */
export function countsFor(
  key: string,
  sites: readonly { site: string; apis: number; watches: number }[] | undefined,
  boosts: number,
): SiteCounts {
  const row = key ? sites?.find((item) => normalizeSite(item.site) === key) : undefined;
  return { apis: row?.apis ?? 0, watches: row?.watches ?? 0, boosts: Math.max(0, boosts) };
}

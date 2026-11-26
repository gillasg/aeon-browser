// The `{ siteSkill: ... }` request browser_code sends, answered from the unified site memory.
// The data folder argument is where the old helper store lived; it is migrated on first use.

import { siteName } from "./registry.js";
import {
  allHelpers,
  domainMatches,
  dropHelper,
  saveHelper,
  validHelperName,
  type SiteHelper,
} from "./site-helpers.js";
import { migrateLegacyHelpers } from "./site-memory-migrate.js";

export type SiteHelperRequest =
  | { siteSkill: "list"; url?: string }
  | { siteSkill: "get"; name: string }
  | { siteSkill: "save"; skill: Partial<SiteHelper> }
  | { siteSkill: "delete"; name: string };

export function isSiteHelperRequest(value: unknown): value is SiteHelperRequest {
  return typeof value === "object" && value !== null && "siteSkill" in value;
}

export async function siteHelperCall(
  legacyDirectory: string | undefined,
  request: SiteHelperRequest,
): Promise<unknown> {
  await migrateLegacyHelpers(legacyDirectory);
  if (request.siteSkill === "list") {
    const host = hostOf(request.url);
    return (await allHelpers())
      .filter((helper) => helper.enabled !== false)
      .filter((helper) => !host || helper.domains.some((domain) => domainMatches(host, domain)))
      .map(({ name, domains, description }) => ({ name, domains, description }));
  }
  if (request.siteSkill === "get") {
    const name = validHelperName(request.name);
    const helper = (await allHelpers()).find(
      (item) => item.name === name && item.enabled !== false,
    );
    if (!helper) throw new Error(`SKILL_NOT_FOUND: ${request.name}`);
    return helper;
  }
  if (request.siteSkill === "delete") {
    await dropHelper(validHelperName(request.name));
    return { deleted: request.name };
  }
  const saved = await saveHelper(request.skill, "agent");
  return { saved: saved.name, domains: saved.domains };
}

/** Every helper, disabled ones included. */
export async function readSiteHelpers(legacyDirectory?: string): Promise<SiteHelper[]> {
  await migrateLegacyHelpers(legacyDirectory);
  return allHelpers();
}

/** Saves helpers from a site pack the user installed; all enabled. */
export async function importSiteHelpers(
  legacyDirectory: string | undefined,
  helpers: Partial<SiteHelper>[],
): Promise<SiteHelper[]> {
  await migrateLegacyHelpers(legacyDirectory);
  const saved: SiteHelper[] = [];
  for (const helper of helpers) saved.push(await saveHelper({ ...helper, enabled: true }, "user"));
  return saved;
}

export async function enableSiteHelpers(
  legacyDirectory: string | undefined,
  site: string,
): Promise<string[]> {
  const host = hostOf(site.includes("://") ? site : `https://${site}`);
  if (!host) throw new Error(`Not a site: ${site}`);
  const enabled: string[] = [];
  for (const helper of await readSiteHelpers(legacyDirectory)) {
    if (helper.enabled !== false || !helper.domains.some((domain) => domainMatches(host, domain)))
      continue;
    await saveHelper({ ...helper, enabled: true }, "user");
    enabled.push(helper.name);
  }
  return enabled;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const bare = hostname.replace(/^\[|\]$/g, "");
    const loopback =
      bare === "localhost" || bare === "127.0.0.1" || bare === "::1" || bare.startsWith("127.");
    return loopback && parsed.port ? parsed.host.toLowerCase() : siteName(hostname);
  } catch {
    return undefined;
  }
}

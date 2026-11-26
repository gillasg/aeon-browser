// Site skills are the helper script ops of the unified site memory: each one is a script op in
// the `api.json` of the hosts it names and is documented in their `SKILL.md`. This module keeps
// the old names; the folder argument is where helpers used to live and is migrated on first use.

import {
  enableSiteHelpers,
  importSiteHelpers,
  isSiteHelperRequest,
  readSiteHelpers,
  siteHelperCall,
  type SiteHelper,
  type SiteHelperRequest,
} from "@browserkit/site-mapper";

export type SiteSkill = SiteHelper;

export function isSiteSkillRequest(value: unknown): value is SiteHelperRequest {
  return isSiteHelperRequest(value);
}

export function siteSkillCall(directory: string, request: SiteHelperRequest): Promise<unknown> {
  return siteHelperCall(directory, request);
}

/** Every skill, including disabled ones. */
export function readSiteSkills(directory: string): Promise<SiteSkill[]> {
  return readSiteHelpers(directory);
}

/** Saves skills from a site pack; everything is enabled. */
export function importSiteSkills(
  directory: string,
  skills: Partial<SiteSkill>[],
): Promise<SiteSkill[]> {
  return importSiteHelpers(directory, skills);
}

export function enableSiteSkills(directory: string, site: string): Promise<string[]> {
  return enableSiteHelpers(directory, site);
}

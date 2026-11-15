// Make an archived version live again as the newest content. It goes through `saveAbility`, so a
// restore cannot weaken a caller contract any more than a fresh save can: dropping an input or an
// output field still needs `breaking`.

import { saveAbility, type Ability, type SaveAbilityOptions } from "./abilities.js";
import { readAbilityVersion } from "./ability-versions.js";
import { siteName } from "./registry.js";

export interface RestoreAbilityOptions {
  /** Allow the old version to drop or retype an input, or drop an output field. */
  breaking?: boolean;
  /** Run the old version's stored cases with this host before writing. */
  host?: SaveAbilityOptions["host"];
}

/** Puts an archived version back, saving it as the current one. */
export async function restoreAbility(
  site: string,
  name: string,
  at: string,
  options: RestoreAbilityOptions = {},
): Promise<{ ability: Ability; warnings: string[] }> {
  const host = siteName(site);
  const version = await readAbilityVersion(host, name, at);
  if (!version) throw new Error(`ABILITY_VERSION_UNKNOWN: ${host} has no version ${at} of ${name}`);
  const now = new Date().toISOString();
  const saved = await saveAbility(
    // The live copy is new: old run stats must not make maintenance trash it as unused.
    {
      ...version,
      name,
      site: host,
      stats: { runs: 0, failures: 0 },
      createdAt: now,
      updatedAt: now,
    },
    {
      replace: true,
      ...(options.breaking ? { breaking: true } : {}),
      ...(options.host ? { host: options.host } : {}),
    },
  );
  return { ability: saved.ability, warnings: saved.warnings };
}

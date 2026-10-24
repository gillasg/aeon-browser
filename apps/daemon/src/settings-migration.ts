import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readConfig, saveConfig } from "@browserkit/credentials";
import { browserkitHome, readBlockedSites, saveBlockedSites } from "@browserkit/tools/host";

// Aeon used to keep its own password-manager.json and blocked list in its data folder. Both now
// live in browserkit's home, shared with browserkit. Merge the old copies once at startup; the
// old files are left in place (never deleted) and are not read again after this.

export async function migrateAeonSettings(dataDirectory: string): Promise<void> {
  const home = browserkitHome();
  await migratePasswordManager(dataDirectory, home);
  await migrateSiteRules(dataDirectory, home);
}

async function migratePasswordManager(dataDirectory: string, home: string): Promise<void> {
  const old = await readJson<{ provider?: unknown; bitwardenSession?: unknown }>(
    join(dataDirectory, "password-manager.json"),
  );
  if (!old) return;
  const current = await readConfig(home);
  const provider =
    current.provider ??
    (old.provider === "bitwarden" || old.provider === "proton" ? old.provider : undefined);
  const bitwardenSession =
    current.bitwardenSession ??
    (typeof old.bitwardenSession === "string" ? old.bitwardenSession : undefined);
  const merged = {
    ...(provider ? { provider } : {}),
    ...(bitwardenSession ? { bitwardenSession } : {}),
  };
  if (JSON.stringify(merged) === JSON.stringify(current)) return;
  await saveConfig(home, merged);
}

async function migrateSiteRules(dataDirectory: string, home: string): Promise<void> {
  const old = await readJson<{ blocked?: unknown }>(join(dataDirectory, "site-rules.json"));
  const blocked = Array.isArray(old?.blocked) ? old.blocked.map(String) : [];
  if (!blocked.length) return;
  const current = await readBlockedSites(home);
  const merged = [...new Set([...current, ...blocked])].sort();
  if (merged.length !== current.length) await saveBlockedSites(merged, home);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

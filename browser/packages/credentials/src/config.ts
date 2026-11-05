import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Bitwarden } from "./bitwarden.js";
import { ProtonPass } from "./proton.js";
import type { Login, SaveLogin } from "./match.js";

// Which password manager signs the agent in. Set once (`setup`), or found by itself: an unlocked
// Bitwarden (BW_SESSION) first, then a signed-in Proton Pass CLI.

export type ProviderName = "bitwarden" | "proton";

export interface BrowserCredentials {
  provider?: ProviderName;
  /** Bitwarden session key from `bw unlock --raw`; the file is readable only by the user. */
  bitwardenSession?: string;
}

export interface CredentialConfig extends BrowserCredentials {
  /**
   * A named Chrome profile's own password manager (`aeon browsers name`), e.g. an eval profile
   * on a test vault while the main profile keeps the user's own. Unnamed or unlisted profiles
   * use the top-level choice.
   */
  browsers?: Record<string, BrowserCredentials>;
}

/** The choice that applies to one browser: its own entry when it has one, else the top level. */
export function configFor(config: CredentialConfig, browser?: string): BrowserCredentials {
  const own = browser ? config.browsers?.[browser] : undefined;
  if (own) return own;
  return {
    ...(config.provider ? { provider: config.provider } : {}),
    ...(config.bitwardenSession ? { bitwardenSession: config.bitwardenSession } : {}),
  };
}

export interface Provider {
  readonly name: string;
  logins(host: string): Promise<Login[]>;
  totp(id: string): Promise<string | undefined>;
  status(): Promise<string>;
  saveLogin(login: SaveLogin): Promise<boolean>;
}

export function configPath(directory: string): string {
  return join(directory, "password-manager.json");
}

export async function readConfig(directory: string): Promise<CredentialConfig> {
  try {
    return JSON.parse(await readFile(configPath(directory), "utf8")) as CredentialConfig;
  } catch {
    return {};
  }
}

export async function saveConfig(directory: string, config: CredentialConfig): Promise<void> {
  const path = configPath(directory);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

export function providerFor(name: ProviderName, config: BrowserCredentials): Provider {
  return name === "bitwarden" ? new Bitwarden(config.bitwardenSession) : protonProvider();
}

function protonProvider(): Provider {
  const proton = new ProtonPass();
  return {
    name: proton.name,
    logins: () => proton.logins(),
    totp: (id) => proton.totp(id),
    status: () => proton.status(),
    saveLogin: (login) => proton.saveLogin(login),
  };
}

/** The configured provider, or the first one that answers unlocked. */
export async function activeProvider(
  directory: string,
  browser?: string,
): Promise<Provider | undefined> {
  const config = configFor(await readConfig(directory), browser);
  if (config.provider) return providerFor(config.provider, config);
  for (const name of ["bitwarden", "proton"] as const) {
    const provider = providerFor(name, config);
    const status = await provider.status().catch(() => "missing");
    if (status === "unlocked") return provider;
  }
  return undefined;
}

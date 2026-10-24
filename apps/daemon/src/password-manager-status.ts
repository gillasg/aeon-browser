import { activeProvider, providerFor, readConfig } from "@browserkit/credentials";

// Which password manager answers Aeon's sign-in requests, and whether it is unlocked. Only the
// provider's name and state leave this module: never a session key, a password or an item.

export type PasswordManagerState = "unlocked" | "locked" | "not_set_up" | "unavailable";

export interface PasswordManagerStatus {
  provider: string | null;
  state: PasswordManagerState;
}

const TTL_MS = 60_000;
let cached: { at: number; value: PasswordManagerStatus } | undefined;
let pending: Promise<PasswordManagerStatus> | undefined;

/** Cached for a minute: reading settings must not spawn a password-manager CLI every time. */
export function readPasswordManagerStatus(directory: string): Promise<PasswordManagerStatus> {
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.value);
  pending ??= probe(directory)
    .catch((): PasswordManagerStatus => ({ provider: null, state: "unavailable" }))
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      pending = undefined;
    });
  return pending;
}

async function probe(directory: string): Promise<PasswordManagerStatus> {
  const config = await readConfig(directory);
  if (!config.provider) {
    // Nothing chosen yet: report the one that answers by itself, if any.
    const active = await activeProvider(directory);
    return active
      ? { provider: active.name, state: "unlocked" }
      : { provider: null, state: "not_set_up" };
  }
  const provider = providerFor(config.provider, config);
  const state = await provider.status().catch(() => "");
  return {
    provider: provider.name,
    state: state === "unlocked" ? "unlocked" : state ? "locked" : "unavailable",
  };
}

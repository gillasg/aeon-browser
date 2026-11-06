import type { VaultAsk } from "./native-browser-vault.js";

// Chrome offers its own "Save password?" on every form that submits a password, whatever saved
// it. A profile on an external password manager (Bitwarden, Proton Pass) already keeps the login
// the agent made, so Chrome's offer is a second, empty-looking copy in browser UI no page code
// can close, and it can take the next click while the window is in front. Such a profile turns
// Chrome's offer off, as those managers' own extensions do; saved Chrome logins still fill. A
// profile with no manager hands Chrome back the user's own setting, since Chrome's prompt is
// then the only way to keep the login (the kernel asks the user to click Save).

const FRESH_MS = 5 * 60_000;
let checked = 0;

/** What Chrome's password saving should be for a profile whose manager is `provider`. */
export function chromeSavingFor(provider: string | null | undefined): "off" | "user" {
  return provider ? "off" : "user";
}

/** Before a submit that carries a password the agent typed: match Chrome's offer to the manager. */
export async function matchChromeSaving(ask: VaultAsk, url: string): Promise<void> {
  if (Date.now() - checked < FRESH_MS) return;
  const answer = (await ask({ credential: "manager", url }).catch(() => undefined)) as
    { provider?: string | null } | undefined;
  if (!answer || !("provider" in answer)) return;
  const setting = chrome.privacy?.services?.passwordSavingEnabled;
  if (!setting) return;
  if (chromeSavingFor(answer.provider) === "off") await setting.set({ value: false });
  else await setting.clear({});
  checked = Date.now();
}

// The daemon says, when this profile connects, whether a password manager (Bitwarden, Proton
// Pass) keeps the logins Aeon makes here. If one does, Chrome's own "Save password?" offer is
// switched off, as those managers' extensions do, so it never pops up over a sign-up; saved Chrome
// logins still fill. With none, the user's own Chrome setting comes back: Chrome's prompt is then
// the only way to keep a login, and Aeon asks the user to click Save.

export function handlePasswordSavingMessage(candidate: unknown): boolean {
  const message = candidate as { kind?: unknown; managed?: unknown } | null;
  if (message?.kind !== "native.password-saving" || typeof message.managed !== "boolean")
    return false;
  void applyPasswordSaving(message.managed);
  return true;
}

async function applyPasswordSaving(managed: boolean): Promise<void> {
  const setting = chrome.privacy?.services?.passwordSavingEnabled;
  if (!setting) return;
  if (managed) await setting.set({ value: false }).catch(() => undefined);
  else await setting.clear({}).catch(() => undefined);
}

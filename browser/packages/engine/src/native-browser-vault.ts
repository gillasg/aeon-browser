import { onEngineInstall } from "./native-engine-install.js";
import { onNode } from "./native-browser-dom.js";
import { withBrowserDebugger } from "./native-browser-session.js";
import { agentTyped } from "./native-browser-password-lock.js";
import { rememberSecrets } from "./native-browser-secrets.js";
import { SessionMap } from "./native-session-map.js";

// Vault login capture: after a password form is filled and submitted, remember the values only
// long enough to ask the password manager to save them. Success comes from the page itself (the
// password field is gone after a navigation or an in-page submit), never from a toast. The value
// never enters a step, progress, result or journal; only the save request carries it, from the
// engine to the host. Saving has no prompt: the never-save list is the user's rule.

export interface VaultForm {
  url: string;
  site: string;
  hasPassword: boolean;
  password: string;
  username: string;
  signup: boolean;
}

export interface VaultCandidate extends VaultForm {
  source: "agent" | "user";
  at: number;
}

export type VaultAsk = (request: unknown) => Promise<unknown>;

// Kept across service worker restarts, so a login made just before one is still saved.
const candidates = new SessionMap<VaultCandidate>("aeon-vault-candidates");
const MAX_AGE = 15 * 60_000;
const NEVER_SAVE = "vault-never-save";

/** Sites the user told Aeon never to save passwords for. */
export async function vaultNeverSaveSites(): Promise<string[]> {
  const saved = (await chrome.storage.local.get(NEVER_SAVE).catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return Array.isArray(saved[NEVER_SAVE])
    ? (saved[NEVER_SAVE] as unknown[]).map(String).filter(Boolean)
    : [];
}

async function neverSave(site: string): Promise<boolean> {
  const host = site.toLowerCase().replace(/^www\./, "");
  return (await vaultNeverSaveSites()).some(
    (entry) => host === entry || host.endsWith("." + entry),
  );
}

const PROBE = `(() => {
  const shown = (el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const fields = [...document.querySelectorAll("input")].filter(shown);
  const password = fields.find((el) => el.type === "password");
  const site = location.hostname.replace(/^www\\./, "");
  if (!password) return {url: location.href, site, hasPassword: false, password: "", username: "", signup: false};
  const form = password.form || password.closest("form");
  const inputs = [...(form || document).querySelectorAll("input")];
  const user = inputs.find((el) => el !== password && ["text", "email", "tel", ""].includes(el.type) &&
    (/username|email/.test(el.autocomplete) || el.type === "email" || /user|email|login|account|identifier|phone|mobile/i.test([el.name, el.id, el.placeholder].join(" "))));
  const signup = password.autocomplete === "new-password" ||
    inputs.some((el) => el !== password && el.type === "password" && el.autocomplete === "new-password") ||
    Boolean(/(sign ?up|register|create account|join)/i.test(document.title + " " + location.pathname));
  return {url: location.href, site, hasPassword: true, password: password.value || "", username: user ? user.value || "" : "", signup};
})()`;

/** Records the values in a password field the agent just filled. */
export async function noteVaultFill(debuggee: chrome.debugger.Debuggee, id: number): Promise<void> {
  if (debuggee.tabId === undefined) return;
  const form = await onNode<VaultForm | null>(debuggee, id, vaultFieldInfo).catch(() => null);
  if (!form) {
    const typed = await onNode<Identity | null>(debuggee, id, identityInfo).catch(() => null);
    if (typed) identities.set(debuggee.tabId, { ...typed, at: Date.now() });
    return;
  }
  if (form.hasPassword && form.password) rememberVaultCandidate(debuggee.tabId, form, "agent");
  await closeChromePopup(debuggee).catch(() => undefined);
}

/**
 * Chrome opens its own password popup (saved logins, "use a strong password?") on a password
 * field the window shows, and it takes the next click meant for the page. Escape closes it, and
 * does nothing in a password field itself.
 */
async function closeChromePopup(debuggee: chrome.debugger.Debuggee): Promise<void> {
  for (const type of ["rawKeyDown", "keyUp"] as const)
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
}

function vaultFieldInfo(this: HTMLInputElement): VaultForm | null {
  if (this.type !== "password") return null;
  const form = this.form || this.closest("form");
  const inputs = [...(form || document).querySelectorAll("input")];
  const user = inputs.find(
    (el) =>
      el !== this &&
      ["text", "email", "tel", ""].includes(el.type) &&
      (/username|email/.test(el.autocomplete) ||
        el.type === "email" ||
        /user|email|login|account|identifier|phone|mobile/i.test(
          [el.name, el.id, el.placeholder].join(" "),
        )),
  );
  const signup =
    this.autocomplete === "new-password" ||
    inputs.some(
      (el) => el !== this && el.type === "password" && el.autocomplete === "new-password",
    ) ||
    /(sign ?up|register|create account|join)/i.test(document.title + " " + location.pathname);
  return {
    url: location.href,
    site: location.hostname.replace(/^www\./, ""),
    hasPassword: true,
    password: this.value || "",
    username: user ? user.value || "" : "",
    signup,
  };
}

interface Identity {
  site: string;
  value: string;
}

// The email or username the agent last typed per tab. Sign-ups that ask for it on one screen
// and the password on the next (X, Google) show no username beside the password, and a login
// saved without one cannot sign in later.
const identities = new SessionMap<Identity & { at: number }>("aeon-vault-identities");

function identityInfo(this: HTMLInputElement): Identity | null {
  if (!["text", "email", "tel", ""].includes(this.type) || !this.value) return null;
  const named = /user|email|login|account|identifier|phone|mobile/i.test(
    [this.name, this.id, this.placeholder, this.getAttribute("aria-label") ?? ""].join(" "),
  );
  if (!(this.type === "email" || /username|email/.test(this.autocomplete) || named)) return null;
  return { site: location.hostname.replace(/^www\./, ""), value: this.value };
}

/** The identity typed earlier on the same site in this tab, for a form that shows none. */
export function earlierIdentity(tabId: number, site: string): string {
  const typed = identities.get(tabId);
  if (!typed || typed.site !== site || Date.now() - typed.at > MAX_AGE) return "";
  return typed.value;
}

export function rememberVaultCandidate(
  tabId: number,
  form: VaultForm,
  source: "agent" | "user",
): void {
  if (!form.password) return;
  // A password a person typed is kept out of everything agent code reads from now on.
  if (source === "user") rememberSecrets([form.password]);
  const username = form.username || earlierIdentity(tabId, form.site);
  candidates.set(tabId, { ...form, username, source, at: Date.now() });
}

export function forgetVaultCandidate(tabId: number): void {
  candidates.delete(tabId);
}

export function vaultCandidate(tabId: number): VaultCandidate | undefined {
  const candidate = candidates.get(tabId);
  if (!candidate) return undefined;
  if (Date.now() - candidate.at > MAX_AGE) {
    candidates.delete(tabId);
    return undefined;
  }
  return candidate;
}

/** Reads the current password form without printing or returning its value to agent code. */
export async function probeVaultForm(tabId: number): Promise<VaultForm | undefined> {
  const value = await withBrowserDebugger(tabId, (debuggee) =>
    chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression: PROBE,
      returnByValue: true,
      silent: true,
    }),
  );
  const form = (value as { result?: { value?: VaultForm } } | undefined)?.result?.value;
  return form && typeof form === "object" ? form : undefined;
}

/** Before a click, keep a password typed without a fill: by the agent's keyboard or a person. */
export async function captureTypedPassword(tabId: number): Promise<void> {
  await candidates.ready;
  if (vaultCandidate(tabId)) return;
  const form = await probeVaultForm(tabId).catch(() => undefined);
  if (!form?.hasPassword || !form.password) return;
  // Typed with the keyboard (keyboard.type, pressSequentially): the agent's own new password.
  rememberVaultCandidate(tabId, form, agentTyped(tabId, form.password) ? "agent" : "user");
}

export function vaultSubmissionSucceeded(after: VaultForm | undefined): boolean {
  return Boolean(after && !after.hasPassword);
}

/**
 * What happened to a login the agent typed: `unsaved` when no external password manager took
 * it, so only Chrome's own "Save password?" prompt (browser UI agent code cannot click) can keep it.
 */
export type VaultOutcome = "saved" | "unsaved" | "skipped" | "failed";

// Logins a password manager failed to save (locked, or its CLI did not answer), kept until the
// user unlocks it and Aeon saves them again. Chrome's own prompt is off while a manager is set up,
// so without this the login would be lost with no way for the user to keep it.
const retries = new SessionMap<VaultCandidate & { provider: string }>("aeon-vault-retries");

/** What the kernel asks when the manager could not save: unlock it, then Done saves it. */
export function unlockToSave(provider: string): string {
  const command = /proton/i.test(provider) ? "pass-cli login" : "aeon signin setup bitwarden";
  return `Aeon could not save this login to ${provider}: it is locked or not answering. Unlock it (in a terminal: ${command}), then click Done and Aeon saves it. Cancel leaves it unsaved.`;
}
export const SAVED_AFTER_UNLOCK =
  "the password manager was locked; the user unlocked it and the login was saved; nothing to check";
export const MANAGER_DID_NOT_SAVE =
  "the password manager could not save the login (still locked or not answering); tell the user in your answer the login is not saved";

/** The manager that failed to save this tab's login, if one is waiting to be saved again. */
export function failedSave(tabId: number): string | undefined {
  return retries.get(tabId)?.provider;
}

/** After the user unlocked the manager: save the waiting login once more. */
export async function retryVaultSave(tabId: number, ask: VaultAsk): Promise<boolean> {
  await retries.ready;
  const waiting = retries.get(tabId);
  if (!waiting) return false;
  const answer = await saveVaultCandidate(waiting, ask);
  if (answer?.saved) retries.delete(tabId);
  return Boolean(answer?.saved);
}

/** A password the user is typing during a hand-off: kept so it can be saved once they submit. */
export async function noteUserLogin(tabId: number): Promise<void> {
  const form = await probeVaultForm(tabId).catch(() => undefined);
  if (!form?.hasPassword || !form.password || agentTyped(tabId, form.password)) return;
  rememberVaultCandidate(tabId, form, "user");
}

/** What the kernel asks the user when no password manager saved a login the agent made. */
export const SAVE_IN_CHROME =
  "Aeon made a login no password manager saved. Click Save in Chrome's password prompt (the key icon in the address bar reopens it), then Done.";
export const VAULT_SAVED =
  "the login (the password you typed) was saved to the user's password manager; nothing to check";
export const VAULT_SAVING =
  "the login (the password you typed) is being saved to the user's password manager; if that fails Aeon asks the user itself, so nothing to check";
export const UNSAVED_LOGIN_SAVED =
  "no password manager saved the password you typed, so the user was asked to save it in Chrome's prompt and said done";
export const UNSAVED_LOGIN_NOTE =
  "no password manager saved the password you typed and the user did not confirm saving it in Chrome's prompt; tell them in your answer that the login may not be saved";

/** After a submit-like action: save the login unless the user's never-save list names the site. */
export async function finishVaultCapture(
  tabId: number,
  ask: VaultAsk,
): Promise<VaultOutcome | undefined> {
  await candidates.ready;
  const candidate = vaultCandidate(tabId);
  if (!candidate) return undefined;
  const after = await probeVaultForm(tabId).catch(() => undefined);
  if (!vaultSubmissionSucceeded(after)) {
    // The form is still there: the site refused it, so there is nothing worth saving.
    forgetVaultCandidate(tabId);
    return undefined;
  }
  candidates.delete(tabId);
  if (await neverSave(candidate.site || new URL(candidate.url).hostname)) return "skipped";
  const answer = await saveVaultCandidate(candidate, ask);
  if (answer?.saved) return "saved";
  // No answer (the run ended while a manager was still saving) is not a refusal: never nag.
  if (!answer) return "skipped";
  // A manager is set up but failed: keep the login and ask the user to unlock it.
  if (answer.provider) {
    retries.set(tabId, { ...candidate, provider: answer.provider });
    return "failed";
  }
  // No manager: a person who typed their own password sees Chrome's prompt themselves.
  return candidate.source === "agent" ? "unsaved" : "skipped";
}

/** The manager's answer (provider null: none is set up), or undefined when no answer came. */
async function saveVaultCandidate(
  candidate: VaultCandidate,
  ask: VaultAsk,
): Promise<{ saved: boolean; provider: string | null } | undefined> {
  try {
    const result = (await ask({
      credential: "save",
      url: candidate.url,
      username: candidate.username,
      password: candidate.password,
      name: candidate.site || new URL(candidate.url).hostname,
    })) as { saved?: boolean; provider?: string | null } | undefined;
    return { saved: Boolean(result?.saved), provider: result?.provider ?? null };
  } catch {
    return undefined;
  }
}

onEngineInstall(() => {
  chrome.tabs.onRemoved.addListener((tabId) => {
    candidates.delete(tabId);
    identities.delete(tabId);
    retries.delete(tabId);
  });
});

export async function offerSaveCandidate(
  tabId: number,
  candidate: VaultCandidate,
  ask: VaultAsk,
): Promise<boolean> {
  void tabId;
  return Boolean((await saveVaultCandidate(candidate, ask))?.saved);
}

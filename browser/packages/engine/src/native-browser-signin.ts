import {
  clearCover,
  clearPasswords,
  scanFields,
  typeCodeBoxes,
  submitForm,
  typeInto,
  waitForChange,
  type SignInFields,
} from "./native-browser-signin-page.js";
import { rememberSecrets } from "./native-browser-secrets.js";
import { finishSignIn, prepareSignIn } from "./native-browser-password-lock.js";
import { messagesSnapshot, waitForInboxCode } from "./native-browser-inbox-code.js";
import { chromeFill, inFront } from "./native-browser-signin-chrome.js";
import { chooserShown, passAccountChooser } from "./native-browser-signin-chooser.js";

// bu.signIn(): sign in to the page the agent is on with a login from the user's password
// manager. The machine looks the login up by the tab's real address; the engine types it into
// the page; the agent's code only ever gets the outcome below, never the password or the code.
// With no external login for the site, Chrome's own saved password fills it instead.
// There is no approval step: calling bu.signIn() is the user's instruction to sign in.

export interface SignInResult {
  signedIn: boolean;
  site: string;
  provider?: string;
  account?: string;
  /** Why it stopped short: the agent decides what to do next (often bu.handoff). */
  reason?:
    | "NO_PASSWORD_MANAGER"
    | "PASSWORD_MANAGER_LOCKED"
    | "PASSWORD_MANAGER_FAILED"
    | "NO_SAVED_LOGIN"
    | "CHOOSE_ACCOUNT"
    | "NO_SIGN_IN_FORM"
    | "NEEDS_CODE"
    | "CAPTCHA"
    /** The site refused the saved login: it looks stale (changed or reset elsewhere). */
    | "SAVED_LOGIN_REJECTED"
    /** The form posts the login to another site: nothing was typed. */
    | "FOREIGN_FORM"
    /** The site wants approval on the user's phone or app, and none came within a minute. */
    | "APPROVE_ON_DEVICE"
    /** A boost or site script runs on this page and could read the password: nothing was typed. */
    | "PAGE_SCRIPTS";
  accounts?: string[];
  detail?: string;
}

interface Login {
  id: string;
  name: string;
  username: string;
  password: string;
  hasTotp: boolean;
}

interface LoginAnswer {
  provider: string | null;
  error?: SignInResult["reason"];
  detail?: string;
  logins: Login[];
}

type Ask = (request: unknown) => Promise<unknown>;
type Inbox = { since: number; before: Set<string> };
interface Attempt {
  /** The external manager's login; none means Chrome's own saved password fills each screen. */
  login?: Login;
  ask: Ask;
  url: string;
  inbox: Inbox;
  /** The account the agent asked for, used to pick it on an account chooser. */
  account?: string | undefined;
}
const MAX_STAGES = 4;
const APPROVE_WAIT_MS = 60_000;

export async function signInToPage(
  tabId: number,
  options: { account?: unknown },
  ask: Ask,
): Promise<SignInResult> {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url ?? "";
  const site = siteOf(url);
  if (!site) throw new Error("INVALID_TARGET: sign-in needs an http(s) page");
  const account = typeof options.account === "string" ? options.account : undefined;
  // Texts already in Google Messages before signing in, so only a code sent now counts.
  const inbox: Inbox = { since: Date.now(), before: await messagesSnapshot() };
  const answer = (await ask({ credential: "login", url, ...(account ? { account } : {}) })) as
    LoginAnswer | undefined;
  const chosen = pickLogin(site, answer, account);
  if (!("login" in chosen))
    return CHROME_FALLBACK.has(chosen.reason)
      ? signInWithChrome(tabId, { ask, url, inbox, account }, chosen)
      : chosen;
  const { login, provider } = chosen;
  const base = { site, provider, account: login.username || login.name };
  const scripts = await prepareSignIn(tabId, url);
  if (scripts)
    return { ...base, signedIn: false, reason: "PAGE_SCRIPTS", detail: scripts.join(", ") };
  rememberSecrets([login.password]);
  const result = await fill(tabId, { login, ask, url, inbox, account }, base);
  if (result.signedIn) await finishSignIn(tabId);
  return result;
}

/** No external login for the site: Chrome's own saved passwords get a turn. */
const CHROME_FALLBACK = new Set<SignInResult["reason"]>(["NO_PASSWORD_MANAGER", "NO_SAVED_LOGIN"]);

async function signInWithChrome(
  tabId: number,
  attempt: Attempt,
  missed: SignInResult,
): Promise<SignInResult> {
  const base = { site: missed.site, provider: "chrome" };
  const scripts = await prepareSignIn(tabId, attempt.url);
  if (scripts)
    return { ...base, signedIn: false, reason: "PAGE_SCRIPTS", detail: scripts.join(", ") };
  const result = await inFront(tabId, () => fill(tabId, attempt, base));
  if (result.reason === "NO_SAVED_LOGIN")
    // Neither manager knows the site: answer as the external manager did.
    return {
      ...missed,
      detail: [missed.detail, "Chrome has no saved password for this site either"]
        .filter(Boolean)
        .join("; "),
    };
  if (result.signedIn) await finishSignIn(tabId);
  return result;
}

function pickLogin(
  site: string,
  answer: LoginAnswer | undefined,
  account: string | undefined,
): SignInResult | { login: Login; provider: string } {
  if (!answer || answer.error || !answer.provider)
    return {
      signedIn: false,
      site,
      reason: answer?.error ?? "NO_PASSWORD_MANAGER",
      ...(answer?.detail ? { detail: answer.detail } : {}),
    };
  const [first, ...rest] = answer.logins;
  if (!first) return { signedIn: false, site, provider: answer.provider, reason: "NO_SAVED_LOGIN" };
  if (rest.length && !account)
    return {
      signedIn: false,
      site,
      provider: answer.provider,
      reason: "CHOOSE_ACCOUNT",
      accounts: answer.logins.map((login) => login.username || login.name),
    };
  return { login: first, provider: answer.provider };
}

type Base = Pick<SignInResult, "site" | "provider" | "account">;

function hasForm(fields: SignInFields | undefined): fields is SignInFields {
  return Boolean(fields && (fields.user || fields.password || fields.code));
}

/** The sign-in form, after getting past an account chooser when one stands in front of it. */
async function openForm(
  tabId: number,
  attempt: Attempt,
  base: Base,
): Promise<SignInFields | SignInResult> {
  const fields = await scanFields(tabId);
  if (hasForm(fields)) return fields;
  const chooser = await passAccountChooser(tabId, attempt.account ?? attempt.login?.username);
  if (chooser.kind === "choose")
    return {
      ...base,
      signedIn: false,
      reason: "CHOOSE_ACCOUNT",
      accounts: chooser.accounts,
      detail: "the page lists remembered accounts: call bu.signIn({account}) with one of them",
    };
  if (chooser.kind === "picked") {
    if (!base.account && chooser.account) base.account = chooser.account;
    if (hasForm(chooser.fields)) return chooser.fields;
    // Picking the account signed straight in (the session was still good).
    if (!(await chooserShown(tabId))) return { ...base, signedIn: true };
  }
  return { ...base, signedIn: false, reason: "NO_SIGN_IN_FORM" };
}

async function fill(tabId: number, attempt: Attempt, base: Base): Promise<SignInResult> {
  const opened = await openForm(tabId, attempt, base);
  if ("signedIn" in opened) return opened;
  let fields: SignInFields | undefined = opened;
  if (fields.foreign)
    return { ...base, signedIn: false, reason: "FOREIGN_FORM", detail: fields.foreign };
  for (let stage = 0; stage < MAX_STAGES && fields; stage++) {
    const stop = attempt.login
      ? await step(tabId, fields, attempt, attempt.login)
      : await chromeStep(tabId, fields, attempt, base);
    if (stop) return { ...base, signedIn: false, reason: stop };
    if (!(fields.user || fields.password || fields.code)) break;
    let next = await waitForChange(tabId, fields);
    if (next?.approve) next = await waitForChange(tabId, next, APPROVE_WAIT_MS);
    if (!next || sameForm(fields, next)) break;
    fields = next;
  }
  return outcome(tabId, fields, base);
}

/** One screen of a sign-in: username, then password, then a one-time code, as the site asks. */
async function step(
  tabId: number,
  fields: SignInFields,
  attempt: Attempt,
  login: Login,
): Promise<SignInResult["reason"] | undefined> {
  if (fields.captcha) return "CAPTCHA";
  if (fields.foreign) return "FOREIGN_FORM";
  if (fields.covered) await clearCover(tabId);
  if (fields.code) return enterCode(tabId, attempt, fields.codeBoxes ?? 0);
  if (fields.user && login.username && fields.userValue !== login.username)
    await typeInto(tabId, "user", login.username);
  if (fields.password) await typeInto(tabId, "password", login.password);
  if (fields.user || fields.password) await submitForm(tabId);
  return undefined;
}

/** One screen filled from Chrome's saved passwords; the account is what Chrome put in the field. */
async function chromeStep(
  tabId: number,
  fields: SignInFields,
  attempt: Attempt,
  base: Base,
): Promise<SignInResult["reason"] | undefined> {
  if (fields.captcha) return "CAPTCHA";
  if (fields.foreign) return "FOREIGN_FORM";
  if (fields.covered) await clearCover(tabId);
  if (fields.code) return enterCode(tabId, attempt, fields.codeBoxes ?? 0);
  // A screen with nothing to sign in to (the page after signing in) is done, not a miss.
  if (!(fields.user || fields.password)) return undefined;
  const filled = await chromeFill(tabId, fields);
  if (!filled) return "NO_SAVED_LOGIN";
  const user = filled.fields.userValue || fields.userValue;
  if (user && !base.account) base.account = user;
  if (!filled.submitted) await submitForm(tabId);
  return undefined;
}

/** The saved authenticator code, else one the site just sent to the user's email or phone. */
async function oneTimeCode(attempt: Attempt): Promise<string | undefined> {
  const { login, ask, url, inbox } = attempt;
  if (login?.hasTotp && login.id) {
    const reply = (await ask({ credential: "totp", url, id: login.id })) as {
      code?: string | null;
    };
    if (reply?.code) return reply.code;
  }
  const site = siteOf(url);
  return site ? (await waitForInboxCode(site, inbox))?.code : undefined;
}

export async function typeCode(tabId: number, code: string, boxes: number): Promise<void> {
  rememberSecrets([code]);
  if (boxes) await typeCodeBoxes(tabId, code, boxes);
  else await typeInto(tabId, "code", code);
  await submitForm(tabId);
}

async function enterCode(
  tabId: number,
  attempt: Attempt,
  boxes: number,
): Promise<SignInResult["reason"] | undefined> {
  const code = await oneTimeCode(attempt);
  if (!code) return "NEEDS_CODE";
  await typeCode(tabId, code, boxes);
  return undefined;
}

async function outcome(
  tabId: number,
  last: SignInFields | undefined,
  base: Base,
): Promise<SignInResult> {
  const now = (await scanFields(tabId)) ?? last;
  if (now?.captcha) return { ...base, signedIn: false, reason: "CAPTCHA" };
  if (now?.approve) return { ...base, signedIn: false, reason: "APPROVE_ON_DEVICE" };
  if (now?.code) return { ...base, signedIn: false, reason: "NEEDS_CODE" };
  if (now?.password) {
    await clearPasswords(tabId);
    return { ...base, signedIn: false, reason: "SAVED_LOGIN_REJECTED" };
  }
  return { ...base, signedIn: true };
}

function sameForm(a: SignInFields, b: SignInFields): boolean {
  return a.url === b.url && a.password === b.password && a.code === b.code && a.user === b.user;
}

function siteOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/**
 * bu.fillCode(): types a code the site just sent by email or text into the page's code field and
 * submits it. Agent code learns only whether it worked and where the code came from.
 */
export async function fillCodeOnPage(
  tabId: number,
  options: { waitMs?: unknown },
): Promise<{ filled: boolean; from?: string; reason?: "NO_CODE_FIELD" | "NO_CODE" }> {
  const fields = await scanFields(tabId);
  const site = fields ? siteOf(fields.url) : undefined;
  if (!fields?.code || !site) return { filled: false, reason: "NO_CODE_FIELD" };
  const waitMs = Number(options.waitMs) || 90_000;
  const found = await waitForInboxCode(site, { since: Date.now() - 180_000, waitMs });
  if (!found) return { filled: false, reason: "NO_CODE" };
  await typeCode(tabId, found.code, fields.codeBoxes ?? 0);
  return { filled: true, from: found.from };
}

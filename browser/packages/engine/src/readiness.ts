// Typed readiness: not just "did the page load" but what the page is. A snapshot gathered in the
// page is classified here, in the extension, so the same rules apply to browser code, the check
// path and anything else asking "is this ready, empty, signed out, walled, missing or broken?".
// The classifier is pure and exhaustively testable; only the snapshot touches a page.

export type ReadinessState =
  "ready" | "empty" | "loading" | "login" | "challenge" | "not-found" | "error";

export interface ReadinessSnapshot {
  readyState?: string;
  url?: string;
  title?: string;
  httpStatus?: number | null;
  textLength?: number;
  textSample?: string;
  heading?: string;
  hasPassword?: boolean;
  hasEmail?: boolean;
  hasSignInLink?: boolean;
  spinner?: boolean;
  ariaBusy?: boolean;
  main?: boolean;
  links?: number;
  rows?: number;
  forms?: number;
  /** An input with autocomplete=one-time-code or a short numeric code field. */
  hasOneTimeCode?: boolean;
  /** A meta refresh tag, the classic passive redirect gate. */
  metaRefresh?: boolean;
  /** A visible captcha widget frame or response field (reCAPTCHA, hCaptcha, Turnstile, Arkose). */
  captchaWidget?: boolean;
}

/**
 * What stands between the agent and the page. `interactive: false` clears by itself (a JS check or
 * a redirect gate): wait it out, never click or reload. `interactive: true` needs the person.
 */
export type GateKind =
  "interstitial" | "captcha" | "verification" | "login" | "two-factor" | "blocked";

export interface Gate {
  kind: GateKind;
  interactive: boolean;
}

/** A clean pause for the user: where, why, and what to tell them. Resume once the gate is gone. */
export interface HumanHandoff {
  url?: string;
  reason: GateKind;
  guidance: string;
  resume: "when-cleared";
}

export interface Readiness {
  state: ReadinessState;
  evidence: string[];
  url?: string;
  title?: string;
  httpStatus?: number | null;
  textLength: number;
  at: string;
  gate?: Gate;
}

// Passive checks: a JavaScript challenge or redirect that clears on its own within seconds.
const PASSIVE = [
  "just a moment",
  "checking your browser",
  "checking if the site connection is secure",
  "verifying your browser",
  "please wait while we verify",
  "redirecting",
  "one moment, please",
];

// Interactive verification: a person has to act. Checked before the passive list.
const INTERACTIVE = [
  "verify you are human",
  "are you a robot",
  "i'm not a robot",
  "press and hold",
  "press & hold",
  "complete the security check",
  "select all images",
  "solve this puzzle",
  "captcha",
];

const BLOCKED = ["access denied", "you have been blocked", "request blocked", "403 forbidden"];

const TWO_FACTOR = [
  "two-step verification",
  "2-step verification",
  "two-factor",
  "2fa",
  "verification code",
  "enter the code",
  "authenticator app",
  "security code",
  "one-time code",
];

const CHALLENGE = [
  "attention required",
  "are you a robot",
  "unusual traffic",
  "enable javascript and cookies to continue",
  "access denied",
  "rate limit",
  "too many requests",
  "cloudflare",
  "datadome",
  "perimeterx",
  "px-captcha",
  "captcha",
];

const LOGIN = [
  "sign in",
  "sign-in",
  "log in",
  "login",
  "create account",
  "welcome back",
  "forgot password",
  "continue with google",
  "continue with apple",
];

const NOT_FOUND = [
  "404",
  "not found",
  "page does not exist",
  "page doesn't exist",
  "no longer available",
  "gone",
];

const ERROR = [
  "application error",
  "something went wrong",
  "internal server error",
  "an error occurred",
  "service unavailable",
  "bad gateway",
];

const EMPTY = [
  "no results",
  "nothing here",
  "no items",
  "no posts",
  "no data",
  "couldn't find",
  "could not find",
];

const includesAny = (haystack: string, needles: string[]): string[] =>
  needles.filter((needle) => haystack.includes(needle));

/**
 * Order matters: a wall beats a form, a loading page beats an empty one, and a 404 beats "ready".
 * Every branch records why, because "empty" without evidence is not actionable.
 */
export function classifyReadiness(snapshot: ReadinessSnapshot): Readiness {
  const title = (snapshot.title ?? "").trim();
  const heading = (snapshot.heading ?? "").trim();
  const text = `${title}\n${heading}\n${snapshot.textSample ?? ""}`.toLowerCase();
  const textLength = snapshot.textLength ?? (snapshot.textSample ?? "").length;
  const evidence: string[] = [];
  const finish = (state: ReadinessState): Readiness => ({
    state,
    evidence,
    ...(snapshot.url ? { url: snapshot.url } : {}),
    ...(title ? { title } : {}),
    httpStatus: snapshot.httpStatus ?? null,
    textLength,
    at: new Date().toISOString(),
  });

  const gated = (state: ReadinessState, kind: GateKind, interactive: boolean): Readiness => ({
    ...finish(state),
    gate: { kind, interactive },
  });

  const interactive = includesAny(text, INTERACTIVE);
  if (snapshot.captchaWidget === true || interactive.length) {
    if (snapshot.captchaWidget === true) evidence.push("captcha widget on the page");
    if (interactive.length)
      evidence.push(`challenge wording (verification): ${interactive.slice(0, 3).join(", ")}`);
    return gated("challenge", snapshot.captchaWidget === true ? "captcha" : "verification", true);
  }
  const blocked = includesAny(text, BLOCKED);
  if (blocked.length && textLength < 2500) {
    evidence.push(`challenge wording (blocked): ${blocked[0]}`);
    return gated("challenge", "blocked", true);
  }
  const passive = includesAny(text, PASSIVE);
  if ((passive.length || snapshot.metaRefresh === true) && textLength < 2500) {
    if (passive.length)
      evidence.push(`challenge wording (passive): ${passive.slice(0, 3).join(", ")}`);
    if (snapshot.metaRefresh === true) evidence.push("meta refresh redirect");
    return gated("challenge", "interstitial", false);
  }
  const challenge = includesAny(text, CHALLENGE);
  if (challenge.length) {
    evidence.push(`challenge wording: ${challenge.slice(0, 3).join(", ")}`);
    const throttled = challenge.some((word) => /rate limit|too many/.test(word));
    return gated("challenge", throttled ? "blocked" : "verification", true);
  }

  const twoFactor = includesAny(`${title}\n${heading}`.toLowerCase(), TWO_FACTOR);
  if (snapshot.hasOneTimeCode === true || (twoFactor.length && (snapshot.forms ?? 0) > 0)) {
    if (snapshot.hasOneTimeCode === true) evidence.push("one-time code field");
    if (twoFactor.length) evidence.push(`two-factor wording: ${twoFactor[0]}`);
    return gated("login", "two-factor", true);
  }

  if (snapshot.hasPassword === true) {
    evidence.push("password field on the page");
    return gated("login", "login", true);
  }
  const login = includesAny(`${heading}\n${title}`.toLowerCase(), LOGIN);
  const walled = textLength < 1500 && (snapshot.forms ?? 0) > 0 && (snapshot.links ?? 0) < 40;
  if (login.length && (walled || (snapshot.hasEmail === true && snapshot.hasSignInLink === true))) {
    evidence.push(`sign-in wording: ${login[0]}`);
    if (walled) evidence.push("little content outside the form");
    return gated("login", "login", true);
  }

  const stillLoading =
    snapshot.readyState !== "complete" || snapshot.spinner === true || snapshot.ariaBusy === true;
  if (stillLoading) {
    if (snapshot.readyState !== "complete")
      evidence.push(`document ${snapshot.readyState ?? "loading"}`);
    if (snapshot.spinner === true) evidence.push("spinner or skeleton visible");
    if (snapshot.ariaBusy === true) evidence.push("aria-busy element");
    return finish("loading");
  }

  const status = snapshot.httpStatus ?? null;
  const headingText = `${title}\n${heading}`.toLowerCase();
  if (status === 404 || status === 410 || includesAny(headingText, NOT_FOUND).length) {
    if (status === 404 || status === 410) evidence.push(`HTTP ${status}`);
    const wording = includesAny(headingText, NOT_FOUND);
    if (wording.length) evidence.push(`not-found wording: ${wording[0]}`);
    return finish("not-found");
  }

  if ((status !== null && status >= 500) || includesAny(headingText, ERROR).length) {
    if (status !== null && status >= 500) evidence.push(`HTTP ${status}`);
    const wording = includesAny(headingText, ERROR);
    if (wording.length) evidence.push(`error wording: ${wording[0]}`);
    return finish("error");
  }

  const rows = snapshot.rows ?? 0;
  const emptyWording = includesAny(text, EMPTY);
  if (emptyWording.length && rows === 0) {
    evidence.push(`empty wording: ${emptyWording[0]}`);
    evidence.push(`no list rows`);
    return finish("empty");
  }
  if (textLength < 200 && rows === 0 && snapshot.main !== true) {
    evidence.push(`only ${textLength} characters of text`);
    evidence.push("no main region or list rows");
    return finish("empty");
  }

  evidence.push(`document complete`);
  if (status !== null) evidence.push(`HTTP ${status}`);
  if (rows > 0) evidence.push(`${rows} list rows`);
  evidence.push(`${textLength} characters of text`);
  if (snapshot.main === true) evidence.push("main region found");
  return finish("ready");
}

const GUIDANCE: Record<GateKind, string> = {
  interstitial: "A browser check that clears by itself: wait, do not click or reload.",
  captcha: "A check for people: ask the user to pass it in the tab, then continue.",
  verification: "The site wants a person to verify: ask the user to finish it in the tab.",
  login: "Signed out: sign in with the password manager, or ask the user to sign in.",
  "two-factor": "The site wants a code: ask the user to enter it in the tab.",
  blocked: "The site refused this request: retrying will not help; use another route.",
};

/** The structured pause for an interactive gate, or undefined when nothing needs the person. */
export function humanHandoff(readiness: Readiness): HumanHandoff | undefined {
  const gate = readiness.gate;
  if (!gate?.interactive) return undefined;
  return {
    ...(readiness.url ? { url: readiness.url } : {}),
    reason: gate.kind,
    guidance: GUIDANCE[gate.kind],
    resume: "when-cleared",
  };
}

export interface WaitOutOptions {
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WaitOutResult {
  outcome: "cleared" | "interactive" | "timeout";
  readiness: Readiness;
  polls: number;
  waitedMs: number;
  handoff?: HumanHandoff;
}

/**
 * Waits out a passive interstitial by polling, never clicking or reloading. Stops at once when the
 * page turns into an interactive gate (hand it to the user) and after `timeoutMs` (default 15 s).
 */
export async function waitOutInterstitial(
  probe: () => Promise<ReadinessSnapshot>,
  options: WaitOutOptions = {},
): Promise<WaitOutResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 15_000, 0), 60_000);
  const intervalMs = Math.max(options.intervalMs ?? 750, 100);
  const started = now();
  let polls = 0;
  for (;;) {
    const readiness = classifyReadiness(await probe());
    polls += 1;
    const waitedMs = now() - started;
    const handoff = humanHandoff(readiness);
    if (handoff) return { outcome: "interactive", readiness, polls, waitedMs, handoff };
    if (readiness.gate?.kind !== "interstitial" && readiness.state !== "loading")
      return { outcome: "cleared", readiness, polls, waitedMs };
    if (waitedMs >= timeoutMs) return { outcome: "timeout", readiness, polls, waitedMs };
    await sleep(Math.min(intervalMs, timeoutMs - waitedMs));
  }
}

/**
 * The page half: one expression that gathers the snapshot without touching the page's own state.
 * Kept as a string because it runs through the page's debugger, not in the extension.
 */
export const readinessSnapshotExpression = `(() => {
  const clean = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const body = document.body;
  const text = clean(body ? body.innerText : "").slice(0, 20000);
  const heading = clean((document.querySelector("h1, h2") || {}).innerText || "");
  const navigation = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
  const status = navigation && typeof navigation.responseStatus === "number" ? navigation.responseStatus : null;
  return {
    readyState: document.readyState,
    url: location.href,
    title: document.title,
    httpStatus: status,
    textLength: text.length,
    textSample: text.slice(0, 4000),
    heading,
    hasPassword: !!document.querySelector("input[type=password]"),
    hasEmail: !!document.querySelector("input[type=email], input[autocomplete=username], input[name*=email i]"),
    hasSignInLink: [...document.querySelectorAll("a, button")].some((node) => /sign\\s*in|log\\s*in/i.test(clean(node.innerText))),
    spinner: !!document.querySelector("[class*=spinner i], [class*=skeleton i], [role=progressbar], [aria-busy=true]"),
    ariaBusy: !!document.querySelector("[aria-busy=true]"),
    main: !!document.querySelector("main, [role=main], article, #content, .content"),
    links: document.links ? document.links.length : 0,
    rows: document.querySelectorAll("li, article, [role=listitem], tr").length,
    forms: document.forms ? document.forms.length : 0,
    hasOneTimeCode: !!document.querySelector("input[autocomplete=one-time-code], input[inputmode=numeric][maxlength='6'], input[name*=otp i]"),
    metaRefresh: !!document.querySelector("meta[http-equiv=refresh i]"),
    captchaWidget: [...document.querySelectorAll("iframe")].some((f) => /recaptcha\\/(api2|enterprise)|hcaptcha\\.com|challenges\\.cloudflare\\.com|arkoselabs|funcaptcha|captcha-delivery\\.com/.test(f.src || "") && !/size=invisible/.test(f.src || "")) || !!document.querySelector("#px-captcha")
  };
})()`;

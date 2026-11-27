// The closed set of failures, for the browser and for everything Node-side (crawl, mapped sites,
// abilities). Each code carries the one move that recovers from it, who it belongs to, and (in
// error-next.ts) the one call to run next. Owners and codes do not change.
//
// - model: the agent asked for something wrong (a bad selector, a missing input, its own code threw).
// - page:  the website did it (an overlay, a crash, a bot wall, a slow or broken site).
// - user:  the user's choice or setup (a blocked site, Cancel on the debugging bar, Chrome closed).
// - ours:  a bug or gap in browserkit. Every one of these is a defect to fix, never expected.
//
// A failure no code names is INTERNAL (ours): an unnamed failure is itself a bug.

import {
  abilityRepairCall,
  ABILITY_REPAIR_HINT,
  errorNext,
  formatCandidateLines,
  INPUT_MAY_HAVE_LANDED_NOTE,
  type ErrorContext,
} from "./error-next.js";

export {
  abilityRepairCall,
  ABILITY_REPAIR_HINT,
  effectNext,
  errorNext,
  formatCandidateLines,
  INPUT_MAY_HAVE_LANDED_NOTE,
  isReadNext,
  NO_NEXT_REASON,
  usableCandidates,
  type EffectNextContext,
  type ErrorCandidate,
  type ErrorContext,
  type ErrorTarget,
} from "./error-next.js";

export type ErrorOwner = "model" | "page" | "user" | "ours";

export const ERRORS = {
  TARGET_NOT_FOUND: [
    "model",
    "nothing on the page matches: read bu.state() and pick a listed element",
  ],
  AMBIGUOUS_TARGET: ["model", "several elements match: narrow the selector or use a bu id"],
  TARGET_HIDDEN: [
    "model",
    "the element is not visible: open the menu or section that holds it first",
  ],
  TARGET_DISABLED: ["model", "the control is disabled: fill what it depends on first"],
  FILE_INPUT: [
    "model",
    "clicking a file input opens the OS file dialog, which cannot be closed from here: set its files with page.upload",
  ],
  TARGET_BLOCKED: ["page", "something covers the element: close the overlay first (bu.clear())"],
  TARGET_LOST: ["page", "the element or page changed under the step: read bu.state() again"],
  NOT_EDITABLE: ["model", "the element does not take typing: target its input"],
  INPUT_FAILED: ["ours", "typing did not land: click the field, then type again"],
  INPUT_MAY_HAVE_LANDED: [
    "page",
    "the action was sent but its result is unknown: " + INPUT_MAY_HAVE_LANDED_NOTE,
  ],
  STALE_REF: ["model", "that bu id is from an older read: read bu.state() again"],
  WRONG_TAB: [
    "model",
    "that t<tab>:e<id> ref belongs to another tab: act on browser.page(<tab>) or read this page.state() again",
  ],
  TAB_DEAD: ["page", "the tab was closed or crashed: open a new one with browser.openTab(url)"],
  TAB_UNRESPONSIVE: [
    "page",
    "the tab stopped answering (hung, or frozen by Chrome and would not wake): open the page again with browser.openTab(url)",
  ],
  DEBUGGER_DETACHED: [
    "user",
    "Chrome dropped control of this tab (usually Cancel on its debugging bar): the next step takes it back; if it happens again, tell the user and stop",
  ],
  USER_HAS_CONTROL: ["user", "the user is using this tab: wait, or ask them"],
  USER_TOOK_CONTROL: [
    "user",
    "the user took this tab over: page.waitForControl() waits until it is given back",
  ],
  EXPECTATION_FAILED: [
    "model",
    "the page is not in the state the code expected: read bu.state() and adjust",
  ],
  REPLAY_ORIGIN: [
    "model",
    "the tab left the page that sent this request: open that page, then replay; the request was not sent",
  ],
  PROTECTED_UI: [
    "user",
    "another extension's popup (usually a password manager's menu) keeps blocking this tab: ask the user to close it or finish the step (bu.handoff), then continue",
  ],
  TAB_READ_ONLY: [
    "model",
    "this tab was opened read-only: read it (state, text, screenshot, navigate), or open another tab to act",
  ],
  TAB_ORIGIN_BLOCKED: [
    "model",
    "this tab may only visit the origins it was opened with (allowedOrigins): open another tab for that site",
  ],
  CLAIM_CONFLICT: [
    "model",
    "another chat is using that tab; browser.attachTab(tab) gives this chat its own copy, or browser.openTab(url, {newTab: true})",
  ],
  RUN_RESET: [
    "user",
    "this chat was stopped or reset while the step ran: start again from a fresh read",
  ],
  TIMEOUT: ["page", "the step took too long: check the page with bu.state() before retrying once"],
  SITE_BLOCKED: [
    "user",
    "the user blocked this site for agents: do not try another route; tell them",
  ],
  PASSWORD_PAGE: [
    "user",
    "a password this code did not type is in the page, so its value is hidden; navigation, reads and clicks still work",
  ],
  UNSUPPORTED: ["page", "this browser cannot do that here: use another way"],
  INVALID_TARGET: ["model", "the target is malformed: pass a tab, a page or a bu id"],
  BROWSER_OFFLINE: ["user", "the browser is not connected: ask the user to open Chrome"],
  DAEMON_OFFLINE: ["ours", "the local service is not running: ask the user to start it"],
  CHROME_ERROR: [
    "ours",
    "Chrome refused the step; its own message follows: change the step, do not repeat it",
  ],
  INVALID_INPUT: ["model", "a required input is missing or malformed: fix it and call again"],
  CODE_ERROR: ["model", "your code threw: fix the code (read the message), not the page"],
  URL_GUESSING: [
    "model",
    "several addresses on this site were not found: stop guessing; open a page that shows the data and read page.network.list(), or use siteMapper",
  ],
  NOT_MAPPED: [
    "model",
    'no learned API yet. Fastest: site_mapper({action:"explore", sites:["host"]}) learns search, product, price and link. Until then, read the page.',
  ],
  SIGNED_OUT: ["user", "the site needs the user signed in: try bu.signIn(), else ask the user"],
  BOT_WALL: [
    "page",
    "the site's bot check refused the call: use the page in a tab; re-recording cannot fix it",
  ],
  SITE_BROKEN: [
    "page",
    "the site answered with an error or changed: retry once, then use the page instead",
  ],
  NETWORK: ["page", "the site could not be reached: retry once, then report it"],
  ABILITY_NEEDS: [
    "ours",
    "this host cannot run that way of the ability: run it where a browser is attached",
  ],
  ABILITY_FAILED: [
    "page",
    "every way of the saved ability failed; the message says why for each: fix that cause, or re-record it with site_mapper heal",
  ],
  ABILITY_INPUT: [
    "model",
    "an input does not match the inputs the ability declares; nothing was sent: fix that input and call again",
  ],
  ABILITY_DRIFT: [
    "page",
    "the page no longer has a control a saved step uses (the closest ones are listed): re-record it with site_mapper heal",
  ],
  WRITE_UNCERTAIN: [
    "page",
    "this write may already have reached the site: read the site back, and call again with a new key only if the change is absent",
  ],
  PERSISTED_QUERY_MISS: [
    "page",
    "the site no longer knows the saved query id: open the page once in a tab so the current one is captured, then call again",
  ],
  NOT_PROVEN: [
    "model",
    "that write was never seen working in the page: do it once in the page, then save the ability again",
  ],
  NO_PAGINATION: [
    "model",
    "this list has no next-page parameter: read one page, or open the page and scroll it",
  ],
  RATE_LIMITED: [
    "page",
    "this page is a throttle interstitial, not the site: retry after a pause and open fewer tabs in parallel",
  ],
  INTERNAL: ["ours", "browserkit failed unexpectedly: report it; do not retry the same call"],
} as const satisfies Record<string, readonly [ErrorOwner, string]>;

export type ErrorCode = keyof typeof ERRORS;

export const ERROR_CODES = Object.keys(ERRORS) as ErrorCode[];

export function isErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERRORS, value);
}

export function errorOwner(code: string): ErrorOwner {
  return isErrorCode(code) ? ERRORS[code][0] : "ours";
}

export function errorHint(code: string): string {
  return isErrorCode(code) ? ERRORS[code][1] : "";
}

/**
 * The call a failure runs with no context, for the codes where one exists. Context (the name that
 * missed, the candidates) is applied by errorNextCall. A code with no safe call is absent.
 */
export const NEXT_CALLS: Partial<Record<ErrorCode, string>> = Object.fromEntries(
  ERROR_CODES.flatMap((code) => {
    const next = errorNext(code);
    return next ? [[code, next]] : [];
  }),
);

/** The safe read after a step that ran but left the page as it was. */
export const NOOP_NEXT_CALL = "await bu.state()";

/** The call to make after a failure, or "" when no call is safe. */
export function errorNextCall(code: string, ctx?: ErrorContext): string {
  return errorNext(code, ctx) ?? "";
}

const HOST_IN_TEXT = /(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})/gi;

/** The explore call that learns one site, when the failure names its host. */
export function exploreCall(detail: string, ctx?: ErrorContext): string {
  const host = hostFrom(ctx?.url) || hostFrom(detail);
  if (!host) return "";
  return `site_mapper({action:"explore", sites:[${JSON.stringify(host)}]})`;
}

const NOT_A_HOST = new Set([
  "ts",
  "js",
  "mjs",
  "cjs",
  "md",
  "json",
  "css",
  "html",
  "map",
  "txt",
  "yaml",
  "yml",
]);

function hostFrom(value: string | undefined): string {
  if (!value) return "";
  HOST_IN_TEXT.lastIndex = 0;
  let found: RegExpExecArray | null;
  while ((found = HOST_IN_TEXT.exec(value))) {
    const host = found[1]?.toLowerCase().replace(/^www\./, "") ?? "";
    const tld = host.slice(host.lastIndexOf(".") + 1);
    if (!host || host.length > 80 || NOT_A_HOST.has(tld)) continue;
    return host;
  }
  return "";
}

/** "CODE: detail", the candidates, the recovery hint, and the call to run next. */
export function describeError(code: string, detail = "", ctx?: ErrorContext): string {
  const head = detail && detail !== code ? `${code}: ${detail}` : code;
  const repair = abilityRepairCall(detail);
  const learn = !repair && code === "NOT_MAPPED" ? exploreCall(detail, ctx) : "";
  const hint = repair
    ? ABILITY_REPAIR_HINT
    : learn
      ? `no learned API yet. Fastest learn: ${learn} (search, product, price, link; one site). Until then, read the page.`
      : protectedPageHint(code, detail) || networkHint(code, detail) || errorHint(code);
  const next = repair || learn || protectedPageNext(code, detail) || errorNextCall(code, ctx);
  return [
    head,
    ...formatCandidateLines(ctx?.candidates),
    ...(hint ? [`Hint: ${hint}`] : []),
    ...(next ? [`Next: ${next}`] : []),
  ].join("\n");
}

const CHROME_PAGE = /\bchrome:\/\//i;

/** Chrome's own pages (chrome://settings, chrome://extensions) refuse every extension. */
function protectedPageHint(code: string, detail: string): string {
  if (code !== "PROTECTED_UI" || !CHROME_PAGE.test(detail)) return "";
  return "Chrome's own pages (chrome://...) cannot be read or driven by any extension: ask the user to make that change themselves";
}

function protectedPageNext(code: string, detail: string): string {
  if (code !== "PROTECTED_UI" || !CHROME_PAGE.test(detail)) return "";
  return "ask_user: That is a Chrome settings page, which I cannot open or change. Could you make that change yourself?";
}

// Chrome's own connection failures: the proxy, the TLS certificate, or the route to the site. None
// of them is Chrome refusing the step, so they are NETWORK, each with what actually went wrong.
const NET_ERROR: ReadonlyArray<[RegExp, string]> = [
  [
    /net::ERR_(SOCKS|PROXY|TUNNEL)_\w+/,
    "the proxy between this browser and the site failed: retry once; if it keeps failing, the proxy is down, so tell the user",
  ],
  [
    /net::ERR_(CERT|SSL)_\w+|net::ERR_BAD_SSL_CLIENT_AUTH_CERT/,
    "the site's security certificate was refused (expired, wrong name or untrusted): do not retry; report it",
  ],
  [
    /net::ERR_(NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|CONNECTION_\w+|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|NETWORK_CHANGED|TIMED_OUT|EMPTY_RESPONSE)/,
    "the site could not be reached: retry once, then report it",
  ],
];

/** NETWORK for Chrome's net::ERR_* connection, proxy and certificate failures; else undefined. */
export function chromeNetErrorCode(message: string): "NETWORK" | undefined {
  return NET_ERROR.some(([pattern]) => pattern.test(message)) ? "NETWORK" : undefined;
}

function networkHint(code: string, detail: string): string {
  if (code !== "NETWORK") return "";
  return NET_ERROR.find(([pattern]) => pattern.test(detail))?.[1] ?? "";
}

/** The code a failure is sent with: its own when the catalog knows it, else its shared one, else CHROME_ERROR. */
export function wireErrorCode(code: string): ErrorCode {
  if (isErrorCode(code)) return code;
  return leadingCode(code) ?? "CHROME_ERROR";
}

/** The next call sent with a failure: the code's own, with the detail it was raised with. */
export function failureNextCall(code: string, detail = "", ctx?: ErrorContext): string {
  return abilityRepairCall(detail) || protectedPageNext(code, detail) || errorNextCall(code, ctx);
}

const TIMEOUT_MIN_MS = 1000;
const TIMEOUT_MAX_MS = 600_000;

/** A cell timeout of 1–999 ms is the minimum. Zero stays zero: the budget is spent. */
export function clampTimeoutMs(timeoutMs: number): { timeoutMs: number; warn?: string } {
  if (!(timeoutMs > 0) || timeoutMs >= TIMEOUT_MIN_MS) return { timeoutMs };
  return { timeoutMs: TIMEOUT_MIN_MS, warn: "[warn] timeoutMs raised to 1000 (minimum)" };
}

interface SchemaIssue {
  path?: unknown[];
  code?: string;
  minimum?: number;
  maximum?: number;
  message?: string;
}

/** A zod issue list as one INVALID_INPUT line. Anything else is left for the caller. */
export function readableSchemaError(message: string): string | undefined {
  const start = message.indexOf("[");
  if (start < 0) return undefined;
  const slice = message.slice(start).trim();
  if (!/^\[\s*\{/.test(slice)) return undefined;
  let issues: SchemaIssue[];
  try {
    issues = JSON.parse(slice) as SchemaIssue[];
  } catch {
    return undefined;
  }
  if (!Array.isArray(issues) || !issues[0] || typeof issues[0] !== "object") return undefined;
  const issue = issues[0];
  const path = Array.isArray(issue.path) ? issue.path : [];
  const field = path.length ? String(path[path.length - 1]) : "input";
  if (field === "timeoutMs")
    return `INVALID_INPUT: timeoutMs must be an integer from ${TIMEOUT_MIN_MS} to ${TIMEOUT_MAX_MS}`;
  if (issue.code === "too_small" && issue.minimum != null)
    return `INVALID_INPUT: ${field} must be >= ${issue.minimum}`;
  if (issue.code === "too_big" && issue.maximum != null)
    return `INVALID_INPUT: ${field} must be <= ${issue.maximum}`;
  return `INVALID_INPUT: ${field} ${issue.message ?? "is invalid"}`;
}

/**
 * Narrower codes a feature throws, each standing for one shared code (and so one owner). The
 * narrow code stays in the message as detail; the shared one leads it.
 */
export const ERROR_ALIASES: Readonly<Record<string, ErrorCode>> = {
  // The model asked for something malformed or impossible.
  INVALID_RULE: "INVALID_INPUT",
  INVALID_ARGUMENT: "INVALID_INPUT",
  // page.act / page.observe.
  INVALID_ACTION: "INVALID_INPUT",
  INVALID_VARIABLE: "INVALID_INPUT",
  INVALID_VARIABLES: "INVALID_INPUT",
  ACT_NOT_FOUND: "TARGET_NOT_FOUND",
  ACT_TARGET_LOST: "TARGET_LOST",
  ACT_REPLAY_PARTIAL: "EXPECTATION_FAILED",
  NEEDS_MODEL: "UNSUPPORTED",
  MODEL_FAILED: "NETWORK",
  // bu.signIn(): the form did not react to the submit (a captcha or a disabled button).
  SUBMIT_NO_EFFECT: "SITE_BROKEN",
  INVALID_PERMISSION: "INVALID_INPUT",
  INVALID_CDP_COMMAND: "INVALID_INPUT",
  INVALID_QUERY: "INVALID_INPUT",
  INVALID_EXTENSION_ID: "INVALID_INPUT",
  INVALID_ELEMENT: "INVALID_TARGET",
  WINDOW_ID: "INVALID_INPUT",
  SITE_UNKNOWN: "INVALID_INPUT",
  UNKNOWN_SETTING: "INVALID_INPUT",
  ZOOM: "INVALID_INPUT",
  TAB_SPLIT: "INVALID_INPUT",
  TOO_EARLY: "INVALID_INPUT",
  TOO_LARGE: "INVALID_INPUT",
  RESULT_TOO_LARGE: "INVALID_INPUT",
  COOKIES_FILTER_REQUIRED: "INVALID_INPUT",
  COLLECT_ROW: "INVALID_INPUT",
  EXTRACT_SCRIPT: "INVALID_INPUT",
  EXTRACT_SCHEMA: "INVALID_INPUT",
  CHALLENGE_STAGE_UNKNOWN: "INVALID_INPUT",
  NOT_RECORDING: "INVALID_INPUT",
  RECORDING_ACTIVE: "INVALID_INPUT",
  JOB_NOT_RESUMABLE: "INVALID_INPUT",
  SCREENSHOT_DIFF_PATH: "INVALID_INPUT",
  SCREENSHOT_DIFF_IMAGE: "INVALID_INPUT",
  SCREENSHOT_DIFF_THRESHOLD: "INVALID_INPUT",
  SCREENSHOT_BASELINE_REQUIRED: "INVALID_INPUT",
  SCREENSHOT_SIZE_MISMATCH: "EXPECTATION_FAILED",
  NOT_FOUND: "TARGET_NOT_FOUND",
  NO_OPTION: "TARGET_NOT_FOUND",
  NO_FRAME: "TARGET_NOT_FOUND",
  FRAME: "TARGET_NOT_FOUND",
  FRAME_NOT_FOUND: "TARGET_NOT_FOUND",
  AMBIGUOUS_PDF: "AMBIGUOUS_TARGET",
  AMBIGUOUS: "AMBIGUOUS_TARGET",
  TARGET_AMBIGUOUS: "AMBIGUOUS_TARGET",
  URL_NOT_ALLOWED: "INVALID_INPUT",
  NO_TAB: "INVALID_TARGET",
  NO_CONTEXT: "INVALID_TARGET",
  // The page or the site.
  HTTP: "SITE_BROKEN",
  GOOGLE_BLOCKED: "BOT_WALL",
  GOOGLE_FAILED: "NETWORK",
  DOWNLOAD_FAILED: "NETWORK",
  DOWNLOAD_INTERRUPTED: "NETWORK",
  PDF_TEXT_UNAVAILABLE: "UNSUPPORTED",
  CLIPBOARD_UNAVAILABLE: "UNSUPPORTED",
  // The user's choice or setup.
  PRIVATE_NETWORK: "SITE_BLOCKED",
  POLICY_BLOCKED: "SITE_BLOCKED",
  EXTENSION_BLOCKED: "SITE_BLOCKED",
  HANDOFF_CANCELLED: "RUN_RESET",
  DEMONSTRATION_STOPPED: "RUN_RESET",
  CLOSED_BY_YOU: "RUN_RESET",
  // Ours: Chrome refused something we asked it for.
  TAB_CLOSE_FAILED: "CHROME_ERROR",
  SCREENSHOT_CAPTURE_FAILED: "CHROME_ERROR",
  SCREENSHOT_DECODE_FAILED: "CHROME_ERROR",
  RECORDING_FAILED: "CHROME_ERROR",
  COOKIES_SET: "CHROME_ERROR",
  COOKIES_REMOVE: "CHROME_ERROR",
  CLIPBOARD_BUSY: "TIMEOUT",
  // Mapped sites' and abilities' narrower codes.
  ABILITY_UNKNOWN: "NOT_MAPPED",
  SITE_TOOL_UNKNOWN: "NOT_MAPPED",
  SITE_PAGE_TOOL_UNKNOWN: "NOT_MAPPED",
  ABILITY_EXISTS: "INVALID_INPUT",
  ABILITY_BAD_WAY: "INVALID_INPUT",
  ABILITY_BAD_SCRIPT: "INVALID_INPUT",
  ABILITY_NO_WAYS: "INVALID_INPUT",
  ABILITY_INPUT_UNUSED: "INVALID_INPUT",
  ABILITY_CONTRACT_WEAKENED: "INVALID_INPUT",
  ABILITY_BAD_CURSOR: "INVALID_INPUT",
  ABILITY_TEST_WRITE: "INVALID_INPUT",
  ABILITY_READ_ONLY: "INVALID_INPUT",
  INVALID_ABILITY_NAME: "INVALID_INPUT",
  ABILITY_TIMEOUT: "TIMEOUT",
  PROVIDER_TIMEOUT: "TIMEOUT",
  PROVIDER_NOT_SENT: "SIGNED_OUT",
};

/** The shared code a message leads with ("TARGET_BLOCKED: covered by …"), aliases included. */
export function leadingCode(message: string): ErrorCode | undefined {
  // A rethrown error can arrive wrapped ("Error: TARGET_NOT_FOUND: …"): the code still leads.
  const head = /^(?:(?:Error|TypeError): )*([A-Z_]+)(?::|\s|$)/.exec(message)?.[1] ?? "";
  return isErrorCode(head) ? head : ERROR_ALIASES[head];
}

/**
 * Who wrote the code that threw. A TypeError in the model's own browser code is the model's
 * (CODE_ERROR); the same TypeError in a tool's Node code is ours (INTERNAL).
 */
export type ErrorSource = "model-code" | "tool";

/**
 * Names a failure: its own code when it leads with one, else the code its words mean; anything
 * left over is INTERNAL, a bug to fix.
 */
export function classifyError(error: unknown, source: ErrorSource = "tool"): ErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  const named = leadingCode(message);
  if (named) return named;
  // A JavaScript mistake is never a page condition, whatever words it holds ("waitForTimeout is
  // not a function" is not a timeout).
  if (jsErrorName(error) || JS_ERROR.test(message))
    return source === "model-code" ? "CODE_ERROR" : "INTERNAL";
  for (const [pattern, code] of NAMED) if (pattern.test(message)) return code;
  // Anything else thrown inside the model's browser code without a code is that code's failure:
  // its own throw, or a browser-code helper refusing the input it was given.
  if (source === "model-code") return "CODE_ERROR";
  return "INTERNAL";
}

/**
 * The model-facing text of a failure in the model's browser code: led by its shared code, the
 * narrower code or the JavaScript error name kept as detail.
 */
export function nameModelCodeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const head = /^([A-Z_]+)(?::|\s|$)/.exec(message)?.[1] ?? "";
  if (isErrorCode(head)) return message;
  const code = classifyError(error, "model-code");
  const name = jsErrorName(error);
  return `${code}: ${name && !message.startsWith(name) ? `${name}: ${message}` : message}`;
}

function jsErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return /^(TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|DataCloneError)$/.test(
    name,
  )
    ? name
    : "";
}

// The model's own JavaScript, when the thrown value lost its class on the way (a realm boundary).
const JS_ERROR =
  /is not defined|is not a function|is not a constructor|is not iterable|Cannot (read|set) properties of|Unexpected (token|end of|identifier|non-whitespace|string|number)|is not valid JSON|Invalid regular expression|could not be cloned|Assignment to constant|Maximum call stack|Failed to fetch dynamically imported module/;

const NAMED: ReadonlyArray<[RegExp, ErrorCode]> = [
  // A schema refusing a request we built (a zod issue list) is ours, never the model's.
  [/^\[\s*\{\s*"(origin|code|expected)"/, "INTERNAL"],
  // Browser and runtime failures that arrive without a code.
  [/different extension|Cannot access a chrome(-extension|:\/\/)/i, "PROTECTED_UI"],
  [/Detached while handling command/i, "TARGET_LOST"],
  [/did not respond/i, "INTERNAL"],
  [/runtime reset|workflow cancelled|cell is no longer active/i, "RUN_RESET"],
  [/^No page is open yet/, "INVALID_TARGET"],
  [/before using an id/, "STALE_REF"],
  [/^Failed to fetch$/, "NETWORK"],
  [
    /net::ERR_(SOCKS|PROXY|TUNNEL|CERT|SSL|NAME_NOT_RESOLVED|CONNECTION|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|TIMED_OUT)/,
    "NETWORK",
  ],
  // Mapped sites' and abilities' own codes.
  [
    /^(SITE_TOOL_(INVALID|PARAMS)|SITE_TOOLS_TOO_LARGE|INVALID_ABILITY_NAME|INVALID_ARGUMENT|MODEL_REQUIRED|YOUTUBE_URL|ABILITY_(EXISTS|BAD_WAY|BAD_SCRIPT|NO_WAYS|INPUT_UNUSED|CONTRACT_WEAKENED|BAD_CURSOR|TEST_WRITE))\b/,
    "INVALID_INPUT",
  ],
  [/^(SITE_TOOL_UNKNOWN|SITE_PAGE_TOOL_UNKNOWN|ABILITY_UNKNOWN)\b/, "NOT_MAPPED"],
  [/^(ABILITY_TIMEOUT|PROVIDER_TIMEOUT)\b/, "TIMEOUT"],
  [/^PROVIDER_NOT_SENT\b/, "SIGNED_OUT"],
  [/^PROVIDER_UI\b/, "SITE_BROKEN"],
  [/^(INPUT_NOT_APPLIED|MEDIA_EMPTY|ABILITY_FAILED)\b/, "SITE_BROKEN"],
  [/^Challenged|bot (wall|check)|captcha|cloudflare|datadome|perimeterx|akamai/i, "BOT_WALL"],
  [/signed[ -]out|not signed in|log ?in required|session (expired|missing)/i, "SIGNED_OUT"],
  [/not mapped|no (learned )?api|unknown site|has no ability|ABILITY_UNKNOWN/i, "NOT_MAPPED"],
  [/^Give |required|missing (the )?\w+|invalid (input|param|argument)|must be/i, "INVALID_INPUT"],
  [/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network|socket hang up/i, "NETWORK"],
  [/HTTP (4\d\d|5\d\d)|status (4\d\d|5\d\d)|ABILITY_FAILED|site_broken|broken/i, "SITE_BROKEN"],
  [/timed? ?out|deadline/i, "TIMEOUT"],
  [/No browser is attached|browser (is )?not connected|BrowserNotConnected/i, "BROWSER_OFFLINE"],
];

// The one call a failure can run as it is. A read, a wait, a reload, help, or ask_user.
// Never a click or a fill: a wrong next is worse than none. Null only when no call is safe,
// and then NO_NEXT_REASON says why.
import type { ErrorCode } from "./errors.js";

export interface ErrorCandidate {
  id: number;
  role: string;
  name: string;
  context?: string;
}

export interface ErrorTarget {
  role?: string;
  name?: string;
  id?: number;
  selector?: string;
}

export interface ErrorContext {
  target?: ErrorTarget;
  tabId?: number;
  url?: string;
  candidates?: ErrorCandidate[];
  query?: string;
}

export interface EffectNextContext {
  op?: string;
  query?: string;
  /** The clicked node has no handler and a child does, at this viewport point. */
  childPoint?: { x: number; y: number };
}

type NextFn = (ctx: ErrorContext) => string;

const STATE = "await bu.state()";

const READ_NEXT =
  /^(?:await bu\.state\(\)|await bu\.state\(\{query: "(?:[^"\\]|\\.){1,160}"\}\)|browser\.tabs\(\)|await page\.reload\(\)|await page\.waitForControl\(\)|await page\.read\(\)|await page\.network\.list\(\)|await help\(\)|ask_user: [^\n]{1,220})$/;

/** A next call an error may name: a read, a wait, a reload, help, or ask_user. */
export function isReadNext(call: string): boolean {
  return READ_NEXT.test(call);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The state read for a failure, scoped when the failing name is known. */
export function stateRead(ctx: ErrorContext = {}): string {
  const raw = asText(ctx.query || ctx.target?.name || ctx.target?.selector)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  if (!raw) return STATE;
  const call = `await bu.state({query: ${JSON.stringify(raw)}})`;
  return isReadNext(call) ? call : STATE;
}

const readState: NextFn = (ctx) => stateRead(ctx);
const tabs: NextFn = () => "browser.tabs()";
const reload: NextFn = () => "await page.reload()";
const waitForControl: NextFn = () => "await page.waitForControl()";
const readPage: NextFn = () => "await page.read()";
const networkList: NextFn = () => "await page.network.list()";
const help: NextFn = () => "await help()";

function ask(question: string): NextFn {
  return () => `ask_user: ${question}`;
}

export const ERROR_NEXT: Record<ErrorCode, NextFn | null> = {
  TARGET_NOT_FOUND: readState,
  AMBIGUOUS_TARGET: readState,
  TARGET_HIDDEN: readState,
  TARGET_DISABLED: readState,
  TARGET_BLOCKED: readState,
  TARGET_LOST: readState,
  NOT_EDITABLE: readState,
  INPUT_FAILED: readState,
  STALE_REF: readState,
  TAB_DEAD: tabs,
  TAB_UNRESPONSIVE: tabs,
  DEBUGGER_DETACHED: readState,
  USER_HAS_CONTROL: ask("You are using this tab. Should I wait and continue?"),
  USER_TOOK_CONTROL: waitForControl,
  EXPECTATION_FAILED: readState,
  PROTECTED_UI: ask(
    "Another extension's popup is blocking this tab. Close it or finish the step, then tell me to continue.",
  ),
  CLAIM_CONFLICT: tabs,
  RUN_RESET: readState,
  TIMEOUT: readState,
  // The user blocked the site. Another route would ignore that choice.
  SITE_BLOCKED: null,
  PASSWORD_PAGE: reload,
  // Nothing this browser can do here has one substitute call.
  UNSUPPORTED: null,
  INVALID_TARGET: tabs,
  BROWSER_OFFLINE: ask("Chrome is not connected. Open it so I can continue?"),
  DAEMON_OFFLINE: ask("The local service is not running. Start it so I can continue?"),
  // Chrome refused the step. Repeating that step is the failure.
  CHROME_ERROR: null,
  INVALID_INPUT: help,
  CODE_ERROR: help,
  URL_GUESSING: networkList,
  NOT_MAPPED: readPage,
  SIGNED_OUT: ask("This site needs you signed in. Sign in, then tell me to continue?"),
  BOT_WALL: readState,
  SITE_BROKEN: readState,
  NETWORK: readState,
  ABILITY_NEEDS: tabs,
  // Another request repeats the limit. The recovery is to report it, not to fetch again.
  RATE_LIMITED: null,
  // An unexpected failure is a bug. Repeating the same call repeats it.
  INTERNAL: null,
};

/** Why a code has no next call. Every null in ERROR_NEXT has one. */
export const NO_NEXT_REASON: Partial<Record<ErrorCode, string>> = {
  SITE_BLOCKED: "the user blocked this site; another route would ignore that choice",
  UNSUPPORTED: "this browser cannot do that here, and no one read replaces it",
  CHROME_ERROR: "Chrome refused the step; repeating the same call repeats it",
  RATE_LIMITED: "another request repeats the limit; the recovery is to report it to the user",
  INTERNAL: "an unexpected failure is a bug; repeating the same call repeats it",
};

function contextOf(ctx: ErrorContext | undefined): ErrorContext {
  return ctx && typeof ctx === "object" ? ctx : {};
}

/** The call to run after this failure, or null when none is safe. */
export function errorNext(code: string, ctx?: ErrorContext): string | null {
  const next = (ERROR_NEXT as Record<string, NextFn | null | undefined>)[code];
  if (!next) return null;
  try {
    const call = next(contextOf(ctx));
    return typeof call === "string" && isReadNext(call) ? call : STATE;
  } catch {
    return STATE;
  }
}

function safePoint(point: { x: number; y: number } | undefined): point is { x: number; y: number } {
  if (!point || typeof point.x !== "number" || typeof point.y !== "number") return false;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  return point.x >= 0 && point.y >= 0 && point.x <= 10000 && point.y <= 10000;
}

/**
 * The call after an effect that was not confirmed. clickAt only when a click missed because
 * the node has no handler and a child does. A confirmed or refused effect names nothing here.
 */
export function effectNext(effect: string, ctx: EffectNextContext = {}): string | null {
  if (effect !== "unverifiable" && effect !== "suspected_noop") return null;
  const point = ctx.childPoint;
  if (effect === "suspected_noop" && ctx.op === "click" && safePoint(point))
    return `await page.clickAt(${Math.round(point.x)}, ${Math.round(point.y)})`;
  return stateRead({ ...(ctx.query ? { query: ctx.query } : {}) });
}

function clean(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/** At most eight candidates, each one line the model can match to an id. */
export function usableCandidates(list: ErrorCandidate[] | undefined): ErrorCandidate[] {
  const out: ErrorCandidate[] = [];
  for (const item of list ?? []) {
    if (out.length >= 8) break;
    if (!item || !Number.isInteger(item.id) || item.id < 0 || item.id > 1_000_000_000) continue;
    const role = clean(asText(item.role), 40);
    const name = clean(asText(item.name), 80);
    if (!role || !name) continue;
    const context = item.context ? clean(asText(item.context), 80) : "";
    out.push({ id: item.id, role, name, ...(context ? { context } : {}) });
  }
  return out;
}

/** One line per candidate: `[id] role "name" (context)`. */
export function formatCandidateLines(list: ErrorCandidate[] | undefined): string[] {
  return usableCandidates(list).map((candidate) => {
    const where = candidate.context ? ` (${candidate.context})` : "";
    return `  [${candidate.id}] ${candidate.role} ${JSON.stringify(candidate.name)}${where}`;
  });
}

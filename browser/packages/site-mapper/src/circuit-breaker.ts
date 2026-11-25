// Invariant I-8: the first bot challenge on a (site, account) pauses Rung-0 (direct/API replay)
// there for 24 hours. Runs go through the live page with human-paced input until it expires.
import type { Challenge } from "./challenge.js";

export const BREAKER_MS = 24 * 60 * 60 * 1000;

export interface BreakerState {
  site: string;
  account: string;
  vendor: Challenge["vendor"];
  trippedAt: number;
  until: number;
}

export interface BreakerClock {
  now(): number;
}

let clock: BreakerClock = { now: () => Date.now() };
let persist: ((states: BreakerState[]) => void) | undefined;
const states = new Map<string, BreakerState>();

const keyOf = (site: string, account = "default") => `${site}\u0000${account}`;

/** Swaps the clock; call with no argument for the real one. */
export function setBreakerClock(next?: BreakerClock): void {
  clock = next ?? { now: () => Date.now() };
}

/** Called with every live breaker after each change, so a caller can save them as JSON. */
export function setBreakerPersistence(save?: (states: BreakerState[]) => void): void {
  persist = save;
}

/** Restores breakers saved by the persistence hook. Expired ones are dropped. */
export function loadBreakers(saved: BreakerState[]): void {
  for (const state of saved)
    if (state.until > clock.now()) states.set(keyOf(state.site, state.account), { ...state });
}

function save(): void {
  persist?.(liveStates());
}

function liveStates(): BreakerState[] {
  return [...states.values()].filter((state) => state.until > clock.now());
}

/** Trips the breaker on the first challenge. A later one while tripped keeps the first window. */
export function recordChallenge(
  site: string,
  wall: Pick<Challenge, "vendor">,
  account = "default",
): BreakerState {
  const live = getBreakerState(site, account);
  if (live) return live;
  const now = clock.now();
  const state = { site, account, vendor: wall.vendor, trippedAt: now, until: now + BREAKER_MS };
  states.set(keyOf(site, account), state);
  save();
  return { ...state };
}

/** The live breaker, or undefined when none is tripped (an expired one is forgotten). */
export function getBreakerState(site: string, account = "default"): BreakerState | undefined {
  const key = keyOf(site, account);
  const state = states.get(key);
  if (!state) return undefined;
  if (state.until > clock.now()) return { ...state };
  states.delete(key);
  save();
  return undefined;
}

/** True while Rung-0 is paused for this (site, account). */
export function isRung0Paused(site: string, account = "default"): boolean {
  return getBreakerState(site, account) !== undefined;
}

/** Clears one breaker, or every breaker when no site is given. */
export function clearBreaker(site?: string, account = "default"): void {
  if (site === undefined) states.clear();
  else states.delete(keyOf(site, account));
  save();
}

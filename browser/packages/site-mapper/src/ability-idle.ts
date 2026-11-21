// While Aeon is idle, saved abilities are checked a few at a time in the background. Reads run
// their small stored cases; writes get a read-only rehearsal and never reach the site. A failure
// caused by the site changing (drift) is re-learned with the existing build path and saved as a new
// version, with the old one kept in history for restore. Sign-outs, bot walls and rate limits are
// not drift: they are left for the user or the next signed-in run. The scheduler is pure so pacing,
// one-site-at-a-time, battery and stop-on-chat can be tested without a browser or a clock.

import type { Ability } from "./abilities.js";
import { saveAbility } from "./abilities.js";
import { appendHealLog, markHealPending, type HealReceipt } from "./ability-heal.js";
import { wayId } from "./ability-stats.js";
import { siteName } from "./registry.js";

/** What a failed check means. Only drift is safe to repair in the background. */
export type FailureKind = "drift" | "signout" | "bot" | "rate_limit" | "unknown";

/**
 * A sign-out or a bot wall is not a broken ability: repairing it would learn the login page or the
 * challenge. Drift is a contract or shape that no longer matches what the site returns.
 */
export function classifyFailure(reason: string): FailureKind {
  const text = reason.toLowerCase();
  if (
    /signed.?out|sign.?out|sign.?in|log ?in|re.?auth|401|403|session expired|token expired|needs? (?:user|you)/.test(
      text,
    )
  )
    return "signout";
  if (
    /bot wall|bot check|captcha|challenge|fresh browser needed|human check|unusual traffic/.test(
      text,
    )
  )
    return "bot";
  if (/rate.?limit|429|too many requests|site.?blocked|temporarily blocked/.test(text))
    return "rate_limit";
  if (/contract:|shape|drift|no longer|missing|unverified|changed|expect|is gone/.test(text))
    return "drift";
  return "unknown";
}

/** The one-line note shown on the Abilities page when a check fails and cannot be fixed. */
export interface AbilityCheckNote {
  at: string;
  ok: boolean;
  reason: FailureKind;
  detail: string;
  /** True when a background re-learn was attempted and did not produce a working version. */
  repairFailed?: boolean;
}

export interface IdleConfig {
  /** At most this many abilities checked in a rolling hour. */
  perHour: number;
  /** How many abilities to work on in one idle visit. */
  batchSize: number;
  /** One site at a time, always. Kept configurable for tests; production uses 1. */
  maxConcurrentSites?: number;
  /** Rolling window, default one hour. */
  windowMs?: number;
}

export interface IdleDeps {
  now?: () => number;
  /** Undefined when the platform cannot tell; a known positive answer pauses idle work. */
  onBattery?: () => boolean | undefined;
}

export const DEFAULT_IDLE_CONFIG: IdleConfig = { perHour: 4, batchSize: 2, maxConcurrentSites: 1 };

interface SiteClaim {
  site: string;
  at: number;
}

/**
 * Decides when background ability work may run. No timers of its own: a caller drives it from its
 * idle loop, which keeps it deterministic and free of wall-clock assertions in tests.
 */
export class IdleScheduler {
  private readonly config: IdleConfig;
  private readonly deps: IdleDeps;
  private readonly windowMs: number;
  private chatRunning = false;
  private done: number[] = [];
  private sites = new Map<string, SiteClaim>();

  constructor(config: Partial<IdleConfig> = {}, deps: IdleDeps = {}) {
    this.config = { ...DEFAULT_IDLE_CONFIG, ...config };
    this.deps = deps;
    this.windowMs = this.config.windowMs ?? 3_600_000;
  }

  /** The moment a chat starts, background work stops; a pending batch is abandoned by the caller. */
  noteChatStart(): void {
    this.chatRunning = true;
  }

  noteChatEnd(): void {
    this.chatRunning = false;
  }

  get chatActive(): boolean {
    return this.chatRunning;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private battery(): boolean | undefined {
    return this.deps.onBattery?.();
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    this.done = this.done.filter((at) => at > cutoff);
    for (const [site, claim] of this.sites)
      if (this.now() - claim.at > this.windowMs) this.sites.delete(site);
  }

  /** Checks in the rolling window. */
  get used(): number {
    this.prune();
    return this.done.length;
  }

  get remaining(): number {
    return Math.max(0, this.config.perHour - this.used);
  }

  /** True when idle work may start right now. */
  canStart(): boolean {
    if (this.chatRunning) return false;
    if (this.battery() === true) return false;
    return this.remaining > 0;
  }

  /** One site at a time: refuses a second site while the first is still claimed. */
  claimSite(site: string): boolean {
    const name = siteName(site);
    if (!name || this.sites.has(name)) return false;
    const limit = this.config.maxConcurrentSites ?? 1;
    if (this.sites.size >= limit) return false;
    this.sites.set(name, { site: name, at: this.now() });
    return true;
  }

  releaseSite(site: string): void {
    this.sites.delete(siteName(site));
  }

  get activeSites(): string[] {
    this.prune();
    return [...this.sites.keys()];
  }

  /** Records one finished check against the hourly budget. */
  recordCheck(): void {
    this.done.push(this.now());
  }

  /** The abilities worth checking next: fewest-recently-checked first, one site at a time. */
  plan(abilities: readonly Ability[]): Ability[] {
    if (!this.canStart()) return [];
    const checked = (ability: Ability) => {
      const at = (ability.options.abilityCheck as AbilityCheckNote | undefined)?.at;
      const time = at ? Date.parse(at) : Number.NaN;
      return Number.isFinite(time) ? time : 0;
    };
    const eligible = abilities
      .filter((ability) => ability.createdBy !== "builtin" && ability.kind !== "write")
      .slice()
      .sort((left, right) => checked(left) - checked(right));
    const chosen: Ability[] = [];
    const sites = new Set<string>();
    for (const ability of eligible) {
      if (chosen.length >= this.config.batchSize) break;
      if (sites.has(ability.site)) continue;
      sites.add(ability.site);
      chosen.push(ability);
    }
    return chosen;
  }
}

/** Adds or replaces the one-line check note on an ability without losing its other options. */
export function withCheckNote(ability: Ability, note: AbilityCheckNote): Ability {
  return { ...ability, options: { ...ability.options, abilityCheck: note } };
}

/** Note from a failed check. A sign-out or bot wall is recorded, never "repaired". */
export function failedCheckNote(
  reason: FailureKind,
  detail: string,
  at = new Date().toISOString(),
): AbilityCheckNote {
  return { at, ok: false, reason, detail };
}

/** What a check found. `operations` names the site-model operations that failed, for repair. */
export interface IdleCheckVerdict {
  ok: boolean;
  reason?: string;
  operations?: string[];
}

export interface IdleRepairDeps {
  /** Runs the read-only check. Writes get a rehearsal; this never performs a real write. */
  check: (ability: Ability) => Promise<IdleCheckVerdict>;
  /** Re-learns a drifted ability in the background and returns a fresh draft, or undefined. */
  relearn: (ability: Ability, failure: IdleCheckVerdict) => Promise<Ability | undefined>;
  now?: () => number;
}

export interface IdleRepairResult {
  ability: Ability;
  status: "ok" | "repaired" | "not-drift" | "unrepaired";
  note?: AbilityCheckNote;
  /** A repair: which version replaced which, for the one-line receipt. */
  healed?: HealReceipt;
}

/**
 * Checks one ability and, when it failed because the site drifted, re-learns and saves a new
 * version. saveAbility archives the previous content, so the old way stays restorable. A check
 * that cannot be fixed is marked with a note the Abilities page can show in one line.
 */
export async function repairAbilityWhileIdle(
  ability: Ability,
  deps: IdleRepairDeps,
): Promise<IdleRepairResult> {
  const result = await checkAndRepair(ability, deps);
  await logOutcome(ability, result).catch(() => undefined);
  return result;
}

async function checkAndRepair(ability: Ability, deps: IdleRepairDeps): Promise<IdleRepairResult> {
  const at = new Date(deps.now?.() ?? Date.now()).toISOString();
  let verdict: IdleCheckVerdict;
  try {
    verdict = await deps.check(ability);
  } catch (error) {
    verdict = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (verdict.ok) {
    return {
      ability: withCheckNote(ability, { at, ok: true, reason: "drift", detail: "checked" }),
      status: "ok",
    };
  }
  const detail = verdict.reason ?? "check failed";
  const reason = classifyFailure(detail);
  if (reason !== "drift") {
    const note = failedCheckNote(reason, detail, at);
    return { ability: withCheckNote(ability, note), status: "not-drift", note };
  }
  await logAttempt(ability, detail, verdict.operations);
  const saved = await relearnAndSave(ability, { ...verdict, reason: detail }, deps);
  if (saved) {
    const note: AbilityCheckNote = { at, ok: true, reason: "drift", detail: "re-learned" };
    return {
      ability: withCheckNote(saved.ability, note),
      status: "repaired",
      note,
      ...(saved.healed ? { healed: saved.healed } : {}),
    };
  }
  const note: AbilityCheckNote = {
    at,
    ok: false,
    reason: "drift",
    detail,
    repairFailed: true,
  };
  return { ability: withCheckNote(ability, note), status: "unrepaired", note };
}

async function logAttempt(
  ability: Ability,
  reason: string,
  operations: string[] | undefined,
): Promise<void> {
  await appendHealLog(ability.site, {
    event: "attempt",
    name: ability.name,
    reason,
    ...(operations?.length ? { operations } : {}),
    ...(ability.version ? { fromVersion: ability.version } : {}),
  }).catch(() => undefined);
}

/** Repairs and failures go to `heal.jsonl`; a plain passing check does not, so the log stays small. */
async function logOutcome(before: Ability, result: IdleRepairResult): Promise<void> {
  if (result.status === "ok") return;
  await appendHealLog(before.site, {
    event: result.status,
    name: before.name,
    ...(result.note?.detail ? { reason: result.note.detail } : {}),
    ...(result.status === "repaired"
      ? {
          fromVersion: result.healed?.fromVersion ?? before.version ?? 1,
          toVersion: result.healed?.toVersion ?? result.ability.version ?? 1,
          ...(result.healed ? { way: result.healed.toWay } : {}),
        }
      : {}),
  });
}

/** Re-learns a drifted ability and saves it as the next version; undefined when nothing came back. */
async function relearnAndSave(
  ability: Ability,
  failure: IdleCheckVerdict & { reason: string },
  deps: IdleRepairDeps,
): Promise<Awaited<ReturnType<typeof saveAbility>> | undefined> {
  let fresh: Ability | undefined;
  try {
    fresh = await deps.relearn(ability, failure);
  } catch {
    fresh = undefined;
  }
  if (!fresh?.ways.length) return undefined;
  const first = ability.ways[0];
  // A check that failed outside a run has not queued a heal; the save below is its repair.
  if (first)
    await markHealPending(ability.site, ability.name, wayId(first), failure.reason).catch(
      () => undefined,
    );
  return saveAbility(
    {
      ...fresh,
      name: ability.name,
      site: ability.site,
      stats: ability.stats,
      createdAt: ability.createdAt,
    },
    { replace: true },
  );
}

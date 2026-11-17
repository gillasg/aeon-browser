// While chats are idle, walk saved abilities a few at a time. Reads are checked with their small
// stored cases; writes are only rehearsed, never applied. A failure caused by the site changing is
// re-learned in a background tab with the existing repair/build path and saved as a new version,
// with the old one kept for restore. Sign-outs, bot walls and rate limits are recorded, not fixed.
// A running chat stops the walk. Nothing here opens a visible tab or asks the user.

import {
  IdleScheduler,
  buildAbility,
  listAbilities,
  listSites,
  readHealth,
  repair,
  repairAbilityWhileIdle,
  testAllAbilities,
  type Ability,
  type AbilityCheckNote,
  type IdleConfig,
  type ModelLike,
} from "@browserkit/site-mapper";
import type { ActivityCounts } from "./daemon-activity.js";

/** Runs one browser_code cell in a background task space. */
export type IdleCellRunner = (code: string) => Promise<unknown>;

export interface IdleWorkerOptions extends Partial<IdleConfig> {
  /** The current daemon activity, to stop the moment a chat starts. */
  activity: () => ActivityCounts;
  /** Runs a read-only check for one ability. */
  check?: (ability: Ability) => Promise<{ ok: boolean; reason?: string }>;
  /** Re-learns a drifted ability in the background. */
  relearn?: (ability: Ability) => Promise<Ability | undefined>;
  /** A background browser_code cell runner, for read-only rehearsals and re-learning. */
  cell?: IdleCellRunner;
  model?: () => Promise<ModelLike>;
  onNote?: (ability: Ability, note: AbilityCheckNote) => void;
}

const TICK_MS = 5 * 60 * 1000;

function report(error: unknown): void {
  process.stderr.write(
    `[ability-idle] ${error instanceof Error ? error.message : String(error)}\n`,
  );
}

/** The ability walk. Driven by a timer and the daemon's activity signal, never by a chat. */
export class AbilityIdleWorker {
  private readonly scheduler: IdleScheduler;
  private readonly options: IdleWorkerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private working = false;

  constructor(options: IdleWorkerOptions) {
    this.options = options;
    this.scheduler = new IdleScheduler(options, {
      onBattery: () => undefined,
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(report), TICK_MS);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One idle visit: stop on chat, take a small plan, one site at a time. */
  async tick(): Promise<void> {
    const activity = this.options.activity();
    if (
      activity.workingChats > 0 ||
      activity.askingChats > 0 ||
      activity.routines > 0 ||
      activity.cells > 0 ||
      activity.abilities > 0
    ) {
      this.scheduler.noteChatStart();
      return;
    }
    this.scheduler.noteChatEnd();
    if (this.working || !this.scheduler.canStart()) return;
    this.working = true;
    try {
      const sites = await listSites().catch(() => [] as { site: string }[]);
      for (const { site } of sites) {
        if (!this.scheduler.canStart()) break;
        if (this.scheduler.claimSite(site)) await this.walkSite(site);
      }
    } finally {
      this.working = false;
    }
  }

  private async walkSite(site: string): Promise<void> {
    try {
      const abilities = await listAbilities(site).catch(() => [] as Ability[]);
      for (const ability of this.scheduler.plan(abilities)) {
        if (!this.scheduler.canStart()) break;
        const result = await repairAbilityWhileIdle(ability, {
          check: this.options.check ?? defaultCheck,
          relearn: this.options.relearn ?? this.defaultRelearn(site, ability),
        });
        this.scheduler.recordCheck();
        if (result.note) this.options.onNote?.(result.ability, result.note);
      }
    } finally {
      this.scheduler.releaseSite(site);
    }
  }

  private defaultRelearn(site: string, ability: Ability) {
    return async (): Promise<Ability | undefined> => {
      const { cell, model } = this.options;
      if (!cell || !model) return undefined;
      const bridge = {
        run: (code: string) => cell(code),
        status: () => Promise.resolve({ browsers: 1 }),
        close: () => undefined,
      };
      await repair(site, [], { bridge } as never);
      const built = await buildAbility(site, ability.description ?? ability.name, {
        model: await model(),
        bridge: () => Promise.resolve(bridge as never),
        name: ability.name,
        kind: ability.kind,
      });
      if (built.blocked || !built.saved) return undefined;
      return (await listAbilities(site)).find((item) => item.name === built.saved);
    };
  }
}

/** Read-only: stored cases in dry mode, plus the last health report's drift status. */
async function defaultCheck(ability: Ability): Promise<{ ok: boolean; reason?: string }> {
  const health = await readHealth(ability.site).catch(() => undefined);
  const failing = health?.results.find(
    (item) => item.status === "drift" || item.status === "broken",
  );
  if (failing) return { ok: false, reason: `contract: ${failing.id} ${failing.status}` };
  const rows = await testAllAbilities({ dry: true, sites: [ability.site] }).catch(() => []);
  const row = rows.find((item) => item.site === ability.site && item.name === ability.name);
  if (row && !row.ok && !row.skipped) return { ok: false, reason: row.error ?? "case failed" };
  return { ok: true };
}

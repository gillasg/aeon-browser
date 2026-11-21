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
  readOnlyHost,
  repair,
  repairAbilityWhileIdle,
  testAbility,
  testAllAbilities,
  type Ability,
  type AbilityCheckNote,
  type AbilityHost,
  type IdleCheckVerdict,
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
  check?: (ability: Ability) => Promise<IdleCheckVerdict>;
  /** Re-learns a drifted ability in the background. */
  relearn?: (ability: Ability, failure: IdleCheckVerdict) => Promise<Ability | undefined>;
  /**
   * The host a live read-only check runs stored cases through. Default: the site's own host with
   * writes refused, used only when a background cell runner (a browser) is available.
   */
  liveHost?: (site: string) => AbilityHost;
  /** Re-records the flows behind failing operations. Default: site-mapper's `repair`. */
  repairOperations?: typeof repair;
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
          check: this.options.check ?? ((item) => this.defaultCheck(item)),
          relearn: this.options.relearn ?? this.defaultRelearn(site),
        });
        this.scheduler.recordCheck();
        if (result.note) this.options.onNote?.(result.ability, result.note);
      }
    } finally {
      this.scheduler.releaseSite(site);
    }
  }

  /** The browser behind the cell runner, as site-mapper's repair and build paths expect it. */
  private bridge(): CellBridge | undefined {
    const { cell } = this.options;
    return cell ? cellBridge(cell) : undefined;
  }

  /** Stored health, then a live read-only run of the stored cases, then a dry check. */
  private async defaultCheck(ability: Ability): Promise<IdleCheckVerdict> {
    const contract = await healthVerdict(ability);
    if (contract) return contract;
    const host = this.liveHost(ability.site);
    if (host && ability.kind === "read" && ability.createdBy !== "builtin" && ability.tests?.length)
      return liveVerdict(ability, host);
    return dryVerdict(ability);
  }

  private liveHost(site: string): AbilityHost | undefined {
    if (this.options.liveHost) return this.options.liveHost(site);
    return this.options.cell ? readOnlyHost(site) : undefined;
  }

  private defaultRelearn(site: string) {
    return async (ability: Ability, failure: IdleCheckVerdict): Promise<Ability | undefined> => {
      const { model } = this.options;
      const bridge = this.bridge();
      if (!bridge || !model) return undefined;
      if (!(await bridge.status()).browsers) return undefined;
      const operations = failure.operations?.length
        ? failure.operations
        : abilityOperations(ability);
      // Re-record the failing operations first so the rebuilt site model knows the new shape.
      if (operations.length)
        await (this.options.repairOperations ?? repair)(site, operations, {
          bridge: () => Promise.resolve(bridge),
        }).catch(report);
      const built = await buildAbility(site, ability.description ?? ability.name, {
        model: await model(),
        bridge: () => Promise.resolve(bridge),
        name: ability.name,
        kind: ability.kind,
      });
      if (built.blocked || !built.saved) return undefined;
      return (await listAbilities(site)).find((item) => item.name === built.saved);
    };
  }
}

interface CellBridge {
  run(code: string): Promise<unknown>;
  status(): Promise<{ browsers: number }>;
  close(): void;
}

/** A bridge over the background cell runner. Its status asks the browser, not a stub. */
export function cellBridge(cell: IdleCellRunner): CellBridge {
  return {
    run: (code) => cell(code),
    status: async () => {
      try {
        await cell("return 1;");
        return { browsers: 1 };
      } catch {
        return { browsers: 0 };
      }
    },
    close: () => undefined,
  };
}

/** The site-model operations an ability's API ways call. */
export function abilityOperations(ability: Ability): string[] {
  const found = new Set<string>();
  for (const way of ability.ways) {
    if (way.kind !== "api") continue;
    if (way.operation) found.add(way.operation);
    for (const step of way.operations ?? []) found.add(step.operation);
  }
  return [...found];
}

/** The last health report's drift for this ability's operations (any, when it names none). */
async function healthVerdict(ability: Ability): Promise<IdleCheckVerdict | undefined> {
  const health = await readHealth(ability.site).catch(() => undefined);
  const used = new Set(abilityOperations(ability));
  const failing = (health?.results ?? []).filter(
    (item) =>
      (item.status === "drift" || item.status === "broken") && (!used.size || used.has(item.id)),
  );
  const first = failing[0];
  if (!first) return undefined;
  return {
    ok: false,
    reason: `contract: ${first.id} ${first.status}`,
    operations: failing.map((item) => item.id),
  };
}

/** Runs the stored cases against the live site through a host that refuses writes. */
async function liveVerdict(ability: Ability, host: AbilityHost): Promise<IdleCheckVerdict> {
  try {
    const result = await testAbility(ability.site, ability.name, { host });
    if (result.ok) return { ok: true };
    const operations = abilityOperations(ability);
    return {
      ok: false,
      reason: `contract: live case failed${result.constant ? " (constant output)" : ""}`,
      ...(operations.length ? { operations } : {}),
    };
  } catch (error) {
    const operations = abilityOperations(ability);
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      ...(operations.length ? { operations } : {}),
    };
  }
}

/** Stored cases in dry mode: no site is called. */
async function dryVerdict(ability: Ability): Promise<IdleCheckVerdict> {
  const rows = await testAllAbilities({ dry: true, sites: [ability.site] }).catch(() => []);
  const row = rows.find((item) => item.site === ability.site && item.name === ability.name);
  if (row && !row.ok && !row.skipped) return { ok: false, reason: row.error ?? "case failed" };
  return { ok: true };
}

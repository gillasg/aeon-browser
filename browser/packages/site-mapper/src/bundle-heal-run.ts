// Runs a bundle repair: read the bundles once per origin (a short cooldown keeps a failing loop
// from re-reading them), propose a rebind, try the call once with it, and save the new operation
// only when that try answered. Writes are never replayed unless the operation is a read.

import type { BundleGraph } from "./bundle-graph.js";
import { appendHealLog } from "./ability-heal.js";
import {
  applyRebind,
  isHealableFailure,
  isPersistedQueryMiss,
  proposeRebind,
  safeToReplay,
  type BundleHealReceipt,
} from "./bundle-heal.js";
import type { Operation, SiteModel } from "./types.js";

export interface BundleHealDeps {
  loadModel(site: string): Promise<SiteModel | undefined>;
  saveModel(model: SiteModel): Promise<unknown>;
  /** The live bundle read for the site (page.code.bundle() / code(..., {bundle: true})). */
  bundle(site: string, op: Operation): Promise<BundleGraph | undefined>;
  /** Calls the operation; with `model`, against that model instead of the saved one. */
  call(
    site: string,
    id: string,
    params: Record<string, unknown>,
    model?: SiteModel,
  ): Promise<unknown>;
  now?: () => number;
}

export interface BundleHealOutcome {
  healed: boolean;
  result?: unknown;
  bundleHeal?: BundleHealReceipt;
  declined?: string;
}

export const BUNDLE_COOLDOWN_MS = 60_000;
const scans = new Map<string, { at: number; graph: Promise<BundleGraph | undefined> }>();

/** Forgets the per-origin bundle reads (tests, or after a deploy is known). */
export function resetBundleHealCache(): void {
  scans.clear();
}

function scan(site: string, op: Operation, deps: BundleHealDeps, now: number) {
  const key = op.origin || site;
  const seen = scans.get(key);
  if (seen && now - seen.at < BUNDLE_COOLDOWN_MS) return seen.graph;
  const graph = deps.bundle(site, op).catch(() => undefined);
  scans.set(key, { at: now, graph });
  return graph;
}

/** Repairs one operation from the bundles and verifies it with one call. Never throws on decline. */
export async function healOpFromBundle(
  site: string,
  id: string,
  params: Record<string, unknown>,
  deps: BundleHealDeps,
  options: { allowWrite?: boolean } = {},
): Promise<BundleHealOutcome> {
  const clock = deps.now ?? Date.now;
  const started = clock();
  const model = await deps.loadModel(site);
  const op = model?.operations.find((item) => item.id === id);
  if (!model || !op) return { healed: false, declined: `${id} is not a mapped operation` };
  if (!options.allowWrite && !safeToReplay(op))
    return { healed: false, declined: "writes are not replayed without allowWrite" };
  const graph = await scan(site, op, deps, started);
  if (!graph) return { healed: false, declined: "no bundle read for this site" };
  const proposal = proposeRebind(op, graph);
  if ("declined" in proposal) return { healed: false, declined: proposal.declined };
  const rebound = applyRebind(op, proposal.rebind);
  const next = { ...model, operations: model.operations.map((o) => (o.id === id ? rebound : o)) };
  const result = await deps.call(site, id, params, next).catch(() => undefined);
  if (result === undefined || isPersistedQueryMiss(result))
    return { healed: false, declined: "the rebound call did not answer" };
  await deps.saveModel(next);
  const { kind, oldTarget, newTarget, confidence } = proposal.rebind;
  const bundleHeal: BundleHealReceipt = {
    operation: id,
    oldTarget,
    newTarget,
    kind,
    durationMs: Math.max(0, clock() - started),
    confidence,
    zeroModelTurns: true,
  };
  await appendHealLog(site, {
    event: "repaired",
    name: id,
    way: `bundle:${kind}`,
    reason: `${oldTarget} → ${newTarget}`,
  }).catch(() => undefined);
  return { healed: true, result, bundleHeal };
}

/** A call that, on a drift-shaped failure, rebinds from the bundles and answers in the same call. */
export async function callWithBundleHeal(
  site: string,
  id: string,
  params: Record<string, unknown>,
  deps: BundleHealDeps,
): Promise<unknown> {
  let failure: unknown;
  try {
    const result = await deps.call(site, id, params);
    if (!isPersistedQueryMiss(result)) return result;
    failure = new Error("PersistedQueryNotFound");
  } catch (error) {
    if (!isHealableFailure(error)) throw error;
    failure = error;
  }
  const outcome = await healOpFromBundle(site, id, params, deps);
  if (outcome.healed) return withReceipt(outcome.result, outcome.bundleHeal);
  throw failure;
}

function withReceipt(result: unknown, bundleHeal: BundleHealReceipt | undefined): unknown {
  if (!bundleHeal || !result || typeof result !== "object" || Array.isArray(result)) return result;
  Object.defineProperty(result, "bundleHeal", { value: bundleHeal, enumerable: false });
  return result;
}

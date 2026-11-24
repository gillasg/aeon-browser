// The last snapshot tree each observed target had, kept so the next `diff` snapshot can say what
// changed. A large page's tree is thousands of fingerprints, so the store is bounded (least
// recently used goes first) and a closed or detached tab's entries are dropped with it.

export interface TreeBaseline {
  documentEpoch: number;
  nodes: Map<number, string>;
}

/** Targets whose baseline is kept; past this, the one used longest ago is dropped. */
export const MAX_TREE_BASELINES = 50;
const baselines = new Map<string, TreeBaseline>();

export function treeBaseline(key: string): TreeBaseline | undefined {
  return baselines.get(key);
}

export function keepTreeBaseline(key: string, baseline: TreeBaseline): void {
  // Re-inserting moves the key to the end, so iteration order is least recently kept first.
  baselines.delete(key);
  baselines.set(key, baseline);
  while (baselines.size > MAX_TREE_BASELINES)
    baselines.delete(baselines.keys().next().value as string);
}

/** Drops every baseline of one tab (keys are `client/run/tabId/incarnation`, plus a frame part). */
export function forgetTrees(tabId: number): void {
  for (const key of [...baselines.keys()])
    if (key.split("/")[2]?.split(/[^0-9]/)[0] === String(tabId)) baselines.delete(key);
}

/** How many baselines are kept, for tests and diagnostics. */
export function treeBaselineCount(): number {
  return baselines.size;
}

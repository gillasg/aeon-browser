// Deterministic test sharding: `--shard=<index>/<total>` (1-indexed). Files are dealt longest
// first onto the lightest shard, so the shards of one run are disjoint, together cover every
// file, and finish near the same time. Every-total-th dealing left one shard with both slow files.
export function parseShard(argv) {
  const arg = argv.find((a) => a.startsWith("--shard"));
  if (arg === undefined) return null;
  const match = /^--shard=(\d+)\/(\d+)$/.exec(arg);
  const index = match ? Number(match[1]) : NaN;
  const total = match ? Number(match[2]) : NaN;
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(total) ||
    total < 1 ||
    index < 1 ||
    index > total
  ) {
    throw new Error(`invalid ${arg}: expected --shard=<index>/<total> with 1 <= index <= total`);
  }
  return { index, total };
}

// Seconds a file takes on a CI runner (Linux, real Chrome). Unlisted files count as DEFAULT_COST.
// bridge.e2e runs about twice as long on macOS (~295s), and every OS shares this table.
// Only rough sizes matter: a stale number moves files between shards, never drops one.
const COST = {
  "bridge.e2e.test.mjs": 300,
  "pace-export.e2e.test.mjs": 195,
  "receipts.e2e.test.mjs": 44,
  "vault-save.e2e.test.mjs": 33,
  "dialogs.e2e.test.mjs": 30,
  "challenge-wait.e2e.test.mjs": 23,
  "page-controls.e2e.test.mjs": 15,
  "cdp-bound.e2e.test.mjs": 15,
  "file-input-click.e2e.test.mjs": 15,
  "evaluate-timeout.e2e.test.mjs": 12,
  "hold.e2e.test.mjs": 11,
  "frame-input.e2e.test.mjs": 10,
};
const DEFAULT_COST = 8;

function cost(file) {
  return COST[file.split(/[\\/]/).pop()] ?? DEFAULT_COST;
}

export function selectShard(files, shard) {
  const sorted = [...files].sort();
  if (!shard) return sorted;
  const loads = Array.from({ length: shard.total }, () => 0);
  const byCost = [...sorted].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : 1));
  const mine = new Set();
  for (const file of byCost) {
    const lightest = loads.indexOf(Math.min(...loads));
    loads[lightest] += cost(file);
    if (lightest === shard.index - 1) mine.add(file);
  }
  return sorted.filter((file) => mine.has(file));
}

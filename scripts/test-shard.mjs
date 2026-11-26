// Deterministic test sharding: `--shard=<index>/<total>` (1-indexed) keeps every total-th file of
// the sorted list, so the shards of one run are disjoint and together cover every file.
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

export function selectShard(files, shard) {
  const sorted = [...files].sort();
  return shard ? sorted.filter((_, idx) => idx % shard.total === shard.index - 1) : sorted;
}

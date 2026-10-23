/** Pi's native edit result owns the diff, including its original line numbers. */
export function projectChangeDiff(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || !("details" in result)) return undefined;
  const details = result.details;
  if (!details || typeof details !== "object" || !("diff" in details)) return undefined;
  if (typeof details.diff !== "string") return undefined;
  // Omit oversized diffs rather than displaying partial changes as complete.
  return details.diff.length <= 24_000 ? details.diff : undefined;
}

/** Reads GRAFT_<suffix>, falling back to the legacy PIPPIN_<suffix> name. */
export function readEnvironment(suffix: string): string | undefined {
  return process.env["GRAFT_" + suffix] ?? process.env["PIPPIN_" + suffix];
}

/** Reads AEON_<suffix>, falling back to the legacy PIPPIN_<suffix> name. */
export function readEnvironment(suffix: string): string | undefined {
  return process.env["AEON_" + suffix] ?? process.env["PIPPIN_" + suffix];
}

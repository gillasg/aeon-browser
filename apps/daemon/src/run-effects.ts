// What a run changed that its receipt can prove: a boost it saved (browser.boosts.save in a
// browser_code cell that succeeded) and a watch whose check runs without a model (create_routine
// with a check that succeeded). Both are read from the tool calls themselves, never from the
// answer text.

export interface BoostEffect {
  /** The boost's id when the cell printed it; the extension finds it by page otherwise. */
  boostId?: string;
  /** The cell saved over an existing boost (it passed an id), rather than making a new one. */
  edit: boolean;
}

const BOOST_SAVE = /\bboosts\s*\.\s*save\s*\(/;
const BOOST_EDIT = /\bboosts\s*\.\s*save\s*\(\s*\{[^}]*\bid\s*:/;
const PRINTED_ID = /["']?\bid["']?\s*:\s*["']([\w:-]{4,80})["']/;

export function savesBoost(code: string): boolean {
  return BOOST_SAVE.test(code);
}

/** The last boost a run saved, from its successful cells. */
export function boostEffect(
  cells: readonly { code: string; ok: boolean; result?: string }[],
): BoostEffect | undefined {
  const cell = [...cells].reverse().find((entry) => entry.ok && savesBoost(entry.code));
  if (!cell) return undefined;
  const boostId = PRINTED_ID.exec(cell.result ?? "")?.[1];
  return { edit: BOOST_EDIT.test(cell.code), ...(boostId ? { boostId } : {}) };
}

/** A create_routine call whose check runs on each slot as code: no model per check. */
export function deterministicWatchCall(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName !== "create_routine") return false;
  const check = typeof args.check === "string" ? args.check.trim() : "";
  const shell = typeof args.checkShell === "string" ? args.checkShell.trim() : "";
  return Boolean(check || shell);
}

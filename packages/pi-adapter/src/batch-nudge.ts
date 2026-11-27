// A live nudge toward fuller browser_code cells. Every cell costs a model turn of several
// seconds while the browser work inside it is a fraction of that, so when one chat's agent sends
// three cells in a row that each did one step (or only read), the third result says so and asks
// for the next steps to share a cell; every third after that says it again. A cell that did
// several steps, or a pause of over a minute, starts the count again. It is advice only: it never
// rides on an error, and a cell with no browser work (help(), maths) neither counts nor breaks a
// run. The same idea as Cua Driver's batch_nudge.rs, sized for Graft's per-chat chat tool.

/** The live hint, on the third tiny cell in a row. One line, so it costs few tokens. */
export const BATCH_NUDGE =
  "Three cells in a row did one quick step each; every cell costs a model turn. Put the write and its read in one cell: fill, click and read together (locators wait for their element, and the page state prints after the cell).";

/** One write then one read is the commonest two-turn pattern, so nudge one cell earlier there. */
export const WRITE_THEN_READ_NUDGE =
  "Two cells in a row: one write, then a read. The page state prints after each cell, so read in the write's cell and save a model turn. Batch fill, click and read together.";

/** Tiny cells in a row before the general nudge, and between nudges. */
export const STREAK_LEN = 3;

/** A pause longer than this ends a streak: the agent stopped and started again. */
export const STREAK_GAP_MS = 60_000;

/** Chats tracked at once; the oldest is dropped past this, so a long-lived daemon stays bounded. */
const MAX_CHATS = 256;

/** Steps that change the page. A cell that did two or more of them is not tiny. */
const WRITE_OPS = new Set([
  "click",
  "fill",
  "paste",
  "press",
  "keys",
  "pointer",
  "upload",
  "navigate",
  "scroll",
  "openTab",
  "downloads",
  "cdp",
]);

/** Steps that mean the agent was not batching browser work at all: a hand-off, a reset. */
const RESET_OPS = new Set(["handoff"]);

/** What one cell did, as far as the nudge cares. */
export interface CellBehaviour {
  /** Steps that changed the page. */
  actions: number;
  /** Steps of any kind, reads included. */
  steps: number;
  /** A hand-off or reset, which ends a run whatever else it did. */
  reset?: boolean;
}

type CellKind = "write" | "read" | "other";

interface Streak {
  count: number;
  last: number;
  kind: CellKind;
}

const streaks = new Map<string, Streak>();

/** Reads the behaviour of a cell from the steps the engine recorded for it. */
export function cellBehaviour(steps: readonly Record<string, unknown>[]): CellBehaviour {
  let actions = 0;
  let reset = false;
  for (const step of steps) {
    const op = (step.action as { op?: unknown } | undefined)?.op;
    if (typeof op !== "string") continue;
    if (RESET_OPS.has(op)) reset = true;
    else if (WRITE_OPS.has(op)) actions++;
  }
  return { actions, steps: steps.length, ...(reset ? { reset: true } : {}) };
}

/**
 * Records one finished (successful) cell and returns the nudge when it should carry one. A tiny
 * cell is one that did at most one step, or only reads; a cell with several steps resets the run.
 */
export function noteBrowserCell(
  chatId: string,
  cell: CellBehaviour,
  now = Date.now(),
): string | undefined {
  if (cell.reset || cell.actions > 1) {
    streaks.delete(chatId);
    return undefined;
  }
  // No browser work at all (help, maths, a workspace write): not a tiny cell, and it does not
  // break a run any more than reading a page does.
  if (cell.steps === 0) return undefined;
  const prior = streaks.get(chatId);
  const count = prior && now - prior.last <= STREAK_GAP_MS ? prior.count + 1 : 1;
  const kind = cellKind(cell);
  remember(chatId, { count, last: now, kind });
  return nudgeFor(count, prior, kind);
}

function cellKind(cell: CellBehaviour): CellKind {
  if (cell.actions === 0) return "read";
  return cell.actions === 1 && cell.steps === 1 ? "write" : "other";
}

function nudgeFor(count: number, prior: Streak | undefined, kind: CellKind): string | undefined {
  if (count === 2 && prior?.kind === "write" && kind === "read") return WRITE_THEN_READ_NUDGE;
  return count % STREAK_LEN === 0 ? BATCH_NUDGE : undefined;
}

/** Forgets a chat (its runtime reset), so the next cell starts a fresh run. */
export function forgetBatchStreak(chatId: string): void {
  streaks.delete(chatId);
}

function remember(chatId: string, streak: Streak): void {
  if (streaks.size >= MAX_CHATS && !streaks.has(chatId)) {
    const oldest = [...streaks].sort((left, right) => left[1].last - right[1].last)[0];
    if (oldest) streaks.delete(oldest[0]);
  }
  streaks.set(chatId, streak);
}

// Holds: the stillness after the impossible moment lands. Nothing moves or cuts inside one.
import type { BeatMark, HoldRegion } from "./types.ts";

export const HOLD_MIN_MS = 1500;
export const HOLD_MAX_MS = 2000;
export const HOLD_DEFAULT_MS = 1800;

/** The hold that strictly contains `t` (its start is the beat itself, which may still land). */
export function holdAt(holds: HoldRegion[], t: number): HoldRegion | undefined {
  return holds.find((h) => t > h.tStart && t < h.tEnd);
}

/** One protected hold after every receipt and result beat. */
export function holdsAfterBeats(beats: BeatMark[], ms = HOLD_DEFAULT_MS): HoldRegion[] {
  const len = Math.min(HOLD_MAX_MS, Math.max(HOLD_MIN_MS, ms));
  return beats
    .filter((b) => b.beat === "receipt" || b.beat === "result")
    .map((b) => ({ tStart: b.t, tEnd: b.t + len }));
}

/** Clip time the camera sees: inside a hold, time stands still at the hold's start. */
export const lockedTime = (holds: HoldRegion[], t: number) => holdAt(holds, t)?.tStart ?? t;

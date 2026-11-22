// Holds lock the camera (see hold.ts). This hook tells a component whether it sits in one, so
// overlays can stay still too.
import { holdAt } from "./hold.ts";
import type { HoldRegion } from "./types.ts";

export function useHold(holds: HoldRegion[], t: number): { held: boolean; since: number } {
  const h = holdAt(holds, t);
  return { held: !!h, since: h ? t - h.tStart : 0 };
}

export { holdAt, holdsAfterBeats, lockedTime, HOLD_DEFAULT_MS } from "./hold.ts";

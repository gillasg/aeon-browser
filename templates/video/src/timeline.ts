// Clip clock <-> video clock. Segments keep stretches of the clip; gaps between them are cuts.
import type { Frame, Segment } from "./types.ts";

export const segmentLength = (s: Segment) => (s.s1 - s.s0) / s.speed;
export const videoLength = (segments: Segment[]) =>
  segments.reduce((sum, s) => sum + segmentLength(s), 0);

/** Clip time shown at video time `vt`. */
export function toSource(segments: Segment[], vt: number): number {
  let v = 0;
  for (const s of segments) {
    const len = segmentLength(s);
    if (vt <= v + len) return s.s0 + Math.max(0, vt - v) * s.speed;
    v += len;
  }
  return segments.at(-1)?.s1 ?? 0;
}

/** Video time at which clip time `t` plays, or undefined when it was cut away. */
export function toVideo(segments: Segment[], t: number): number | undefined {
  let v = 0;
  for (const s of segments) {
    if (t >= s.s0 && t <= s.s1) return v + (t - s.s0) / s.speed;
    v += segmentLength(s);
  }
  return undefined;
}

export function segmentAt(segments: Segment[], vt: number): Segment | undefined {
  let v = 0;
  for (const s of segments) {
    const len = segmentLength(s);
    if (vt <= v + len) return s;
    v += len;
  }
  return undefined;
}

/** The frame on or before clip time `t`. */
export function frameAt(frames: Frame[], t: number): Frame | undefined {
  let lo = 0;
  let hi = frames.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]!.t <= t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return frames[best];
}

/** Wall clock (HH:MM:SS, UTC unless a zone is given) for a clip time: the TimeCut's honest label. */
export function wallClock(startedAt: number, t: number, timeZone = "UTC"): string {
  return new Date(startedAt + t).toLocaleTimeString("en-GB", { hour12: false, timeZone });
}

import type { Edit, Segment, Frame } from "./types";

/** ms of title card before the picture. */
export const introMs = (edit: Edit) => (edit.intro ? edit.intro.duration : 0);
export const outroMs = (edit: Edit) => (edit.outro ? edit.outro.duration : 0);
export const videoDuration = (segments: Segment[]) =>
  segments.reduce((sum, s) => sum + (s.s1 - s.s0) / s.speed, 0);
export const totalDuration = (edit: Edit) =>
  introMs(edit) + videoDuration(edit.segments) + outroMs(edit);

/** Source time at video time vt: a speed segment advances source faster. */
export function toSource(segments: Segment[], vt: number): number {
  let v = 0;
  for (const s of segments) {
    const len = (s.s1 - s.s0) / s.speed;
    if (vt <= v + len) return s.s0 + (vt - v) * s.speed;
    v += len;
  }
  return segments.at(-1)?.s1 ?? 0;
}

/** Which segment is playing at video time vt (the badge reads its speed). */
export function segmentAt(segments: Segment[], vt: number): Segment | undefined {
  let v = 0;
  for (const s of segments) {
    const len = (s.s1 - s.s0) / s.speed;
    if (vt <= v + len) return s;
    v += len;
  }
  return undefined;
}

/** Where a source time starts in video time (for placing badges/captions). */
export function videoStart(segments: Segment[], target: Segment): number {
  let v = 0;
  for (const s of segments) {
    if (s === target) return v;
    v += (s.s1 - s.s0) / s.speed;
  }
  return 0;
}

/** Frame on or before source time st. */
export function frameAt(frames: Frame[], st: number): Frame | undefined {
  let lo = 0;
  let hi = frames.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]!.t <= st) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return frames[best];
}

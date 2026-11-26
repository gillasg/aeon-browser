// House mode: the launch-film grammar as checks. On top of the taste linter it counts cuts and
// camera moves, refuses a dirty, stuttering or soft take, an unaligned Pair, a fixture host in the
// End and time running backwards. Editorial captions stay allowed (the founder's call).
import { segmentLength } from "./timeline.ts";
import type { DirectorEdit } from "./types.ts";

export type HouseRule =
  "cuts" | "moves" | "clean" | "dup-drop" | "dpr" | "aligned" | "end-host" | "monotonic";
export type HouseIssue = { rule: HouseRule; message: string };

export const MAX_CUTS_PER_20S = 4;
export const WINDOW_MS = 20_000;
export const MAX_DUP_DROP = 0.005;
export const MIN_DPR = 3;
const EXAMPLE_HOST = /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.example\b/i;

/** Video times of every cut: a gap between segments, or a TimeCut. */
export function cutTimes(edit: DirectorEdit): number[] {
  const out: number[] = [];
  let v = 0;
  edit.segments.forEach((s, i) => {
    const prev = edit.segments[i - 1];
    if (prev && Math.abs(s.s0 - prev.s1) > 1) out.push(v);
    v += segmentLength(s);
  });
  for (const c of edit.timeCuts) out.push(c.t);
  return out.sort((a, b) => a - b);
}

/** Most cuts in any 20 s window. */
export function maxCutsInWindow(times: number[], windowMs = WINDOW_MS): number {
  let best = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    while (times[i]! - times[j]! >= windowMs) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

/** Camera moves that start between one beat and the next (before the first beat counts too). */
export function movesPerBeat(edit: DirectorEdit): number[] {
  const marks = [...new Set(edit.beats.map((b) => b.t))].sort((a, b) => a - b);
  const counts = new Array(marks.length + 1).fill(0) as number[];
  for (const cue of edit.cues) {
    const slot = marks.filter((t) => t <= cue.tStart).length;
    counts[slot]! += 1;
  }
  return counts;
}

function monotonic(edit: DirectorEdit): string | undefined {
  for (const [i, s] of edit.segments.entries()) {
    if (!(s.s1 >= s.s0)) return `segment ${i} ends before it starts`;
    const prev = edit.segments[i - 1];
    if (prev && s.s0 < prev.s1 - 1) return `segment ${i} plays clip time already shown`;
  }
  for (let i = 1; i < edit.source.frames.length; i++)
    if (edit.source.frames[i]!.t < edit.source.frames[i - 1]!.t) return `frame ${i} goes back`;
  for (let i = 1; i < edit.beats.length; i++)
    if (edit.beats[i]!.t < edit.beats[i - 1]!.t) return `beat ${i} goes back in time`;
  for (const line of edit.editorial)
    if (line.tEnd < line.tStart) return `editorial "${line.text}" ends before it starts`;
  return undefined;
}

function takeIssues(edit: DirectorEdit, fail: (r: HouseRule, m: string) => void): void {
  const take = edit.take;
  if (take?.clean === false)
    fail("clean", "an infobar or bubble stole the viewport during the take: reshoot");
  const bad = (take?.dropped ?? 0) + (take?.dup ?? 0);
  const share = bad / Math.max(1, take?.frames ?? 1);
  if (share > MAX_DUP_DROP)
    fail("dup-drop", `${(share * 100).toFixed(2)}% of frames dropped or duplicated (max 0.5%)`);
  const dpr = edit.source.dpr;
  if (dpr === undefined || dpr < MIN_DPR)
    fail(
      "dpr",
      `the take is DPR ${dpr ?? "unknown"}; house films need DPR 3 (setup-recording-chrome.sh defaults to it)`,
    );
}

export function houseIssues(edit: DirectorEdit): HouseIssue[] {
  const issues: HouseIssue[] = [];
  const fail = (rule: HouseRule, message: string) => issues.push({ rule, message });
  const cuts = maxCutsInWindow(cutTimes(edit));
  if (cuts > MAX_CUTS_PER_20S) fail("cuts", `${cuts} cuts inside 20 s (max ${MAX_CUTS_PER_20S})`);
  const moves = Math.max(0, ...movesPerBeat(edit));
  if (moves > 1) fail("moves", `${moves} camera moves on one beat (max 1)`);
  takeIssues(edit, fail);
  const pair = edit.pair;
  if (
    pair &&
    (pair.aligned === false || (pair.aligned === undefined && pair.alignPageY === undefined))
  )
    fail("aligned", "the Pair has no scanline join: add an align step (or page.why provenance)");
  const end = `${edit.end?.command ?? ""} ${edit.end?.repo ?? ""}`;
  if (EXAMPLE_HOST.test(end)) fail("end-host", `the End names a fixture host (${end.trim()})`);
  const back = monotonic(edit);
  if (back) fail("monotonic", back);
  return issues;
}

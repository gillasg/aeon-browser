// The automatic edit: a long take becomes a short film, honestly. Real time around every story
// beat, the prompt typed at its real keystroke times, Enter → result when it is quick, a 1.8 s
// Hold after each receipt and 3 s on the Pair; every other stretch plays at one labelled speed
// from a fixed ladder. No cut inside a take: cuts happen only between scenes.
import { HOLD_DEFAULT_MS } from "./hold.ts";
import type { PairSpec, RecordingEvents, Segment, VideoEvent } from "./types.ts";

export const SPEED_LADDER = [2, 3, 4, 8, 16, 32, 64] as const;
export const LEAD_MS = 700;
export const TAIL_MS = 300;
export const MISSING_SHOT_MS = 3000;
export const PAIR_STILL_MS = 3000;
/** Gaps shorter than this stay real time: a speed flash nobody can read is not honest either. */
export const MIN_GAP_MS = 400;

type Span = [number, number];

const merge = (spans: Span[]): Span[] => {
  const out: Span[] = [];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last && a <= last[1] + MIN_GAP_MS) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
};

const typed = (e: VideoEvent) => e.beat === "key" || e.kind === "type";

/** Clip time the Pair reveals: the first `learned` beat, else the terminal's `Learned on …` row. */
export function pairMoment(recording: RecordingEvents): number | undefined {
  const learned = recording.events.find((e) => e.beat === "learned");
  if (learned) return learned.t;
  const line = recording.terminal?.events.find(
    (e) => e.kind !== "in" && /(^|\n)Learned on /.test(e.text),
  );
  return line?.t;
}

/** Stretches that must play at 1×, on the clip clock. */
export function realTimeSpans(recording: RecordingEvents, durationMs: number): Span[] {
  const spans: Span[] = [];
  const ev = recording.events;
  for (const e of ev) {
    if (!e.beat && !typed(e)) continue;
    const tail = e.beat === "receipt" || e.beat === "result" ? HOLD_DEFAULT_MS : TAIL_MS;
    spans.push([e.t - LEAD_MS, e.t + tail + (e.kind === "type" ? (e.text?.length ?? 0) * 55 : 0)]);
  }
  for (const send of ev.filter((e) => e.beat === "send")) {
    const result = ev.find((e) => e.t > send.t && (e.beat === "receipt" || e.beat === "result"));
    if (result && result.t - send.t <= MISSING_SHOT_MS) spans.push([send.t, result.t]);
  }
  const pair = pairMoment(recording);
  if (pair !== undefined) spans.push([pair - LEAD_MS, pair + PAIR_STILL_MS]);
  const clamp = (t: number) => Math.max(0, Math.min(durationMs, t));
  return merge(spans.map(([a, b]): Span => [clamp(a), clamp(b)])).filter(([a, b]) => b > a);
}

/** The smallest ladder factor that fits the gaps into what the target leaves. */
export function speedFor(gapMs: number, budgetMs: number): number {
  if (gapMs <= 0) return 1;
  if (budgetMs >= gapMs) return 1;
  for (const f of SPEED_LADDER) if (gapMs / f <= Math.max(0, budgetMs)) return f;
  return SPEED_LADDER.at(-1)!;
}

export const speedLabel = (speed: number) => `${speed}×`;

/** Segments for one take: real time on the story, one labelled speed for everything between. */
export function autoEdit(recording: RecordingEvents, targetMs = 30_000): Segment[] {
  const clip = recording.clip;
  const durationMs = clip.durationMs || (clip.frames / Math.max(1, clip.fps)) * 1000;
  if (durationMs <= 0) return [{ s0: 0, s1: 0, speed: 1 }];
  const real = realTimeSpans(recording, durationMs);
  const gaps: Span[] = [];
  let at = 0;
  for (const [a, b] of real) {
    if (a > at) gaps.push([at, a]);
    at = b;
  }
  if (at < durationMs) gaps.push([at, durationMs]);
  const realMs = real.reduce((sum, [a, b]) => sum + (b - a), 0);
  const gapMs = gaps.reduce((sum, [a, b]) => sum + (b - a), 0);
  const speed = speedFor(gapMs, targetMs - realMs);
  const pieces: Segment[] = [
    ...real.map(([s0, s1]) => ({ s0, s1, speed: 1 })),
    ...gaps.map(([s0, s1]) =>
      speed === 1 || s1 - s0 < MIN_GAP_MS
        ? { s0, s1, speed: 1 }
        : { s0, s1, speed, label: speedLabel(speed) },
    ),
  ].sort((x, y) => x.s0 - y.s0);
  return joinSegments(pieces);
}

/** Neighbouring segments at the same speed become one. */
function joinSegments(pieces: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const p of pieces) {
    const last = out.at(-1);
    if (last && last.speed === p.speed && Math.abs(last.s1 - p.s0) < 1) last.s1 = p.s1;
    else out.push({ ...p });
  }
  return out;
}

/** The Pair from the recording alone: when it reveals, and the scanline join if one was made. */
export function autoPair(
  recording: RecordingEvents,
  scale: { x: number; y: number },
): PairSpec | undefined {
  const at = pairMoment(recording);
  if (at === undefined) return undefined;
  const a = recording.align;
  if (!a) return { pairAtMs: at };
  const box = a.box;
  return {
    pairAtMs: at,
    aligned: a.aligned,
    via: a.via,
    ...(box ? { alignPageY: Math.round((box.y + box.height / 2) * scale.y) } : {}),
    ...(a.line !== undefined ? { alignTerminalLine: a.line } : {}),
  };
}

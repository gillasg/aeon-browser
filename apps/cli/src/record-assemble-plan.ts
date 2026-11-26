// `aeon record assemble`, the pure half: which stretches of each take to keep (dead air trimmed
// around real events and marks), where the camera may punch in (never past native pixels), the
// score on the output clock, and the ffmpeg arguments that render it all in one pass.
import type { Box, Mark, RecordingEvents, SoundCue, VideoEvent } from "./record-events.js";
import { soundCuesFromEvents } from "./record-events.js";
import { hitKind, type ScoreHit } from "./record-score.js";

export type Span = { start: number; end: number };
/** One kept stretch of one take, placed on the output clock at `at`. */
export type Segment = Span & { take: number; at: number };
/** Something that happened at clip time `t`, maybe with a box to look at, maybe a beat to hold. */
export type Beat = { t: number; box?: Box; hold?: boolean };
export type Take = { clip: string; recording: RecordingEvents; marks: Mark[] };
export type Size = { width: number; height: number };
export type AssembleOptions = Size & {
  fps: number;
  maxIdleMs?: number;
  zoom?: boolean;
  /** A title card at the end: the command and the repo. */
  end?: { cmd?: string; repo?: string; textFiles?: { cmd?: string; repo?: string } };
  endMs?: number;
  audio?: string;
  drawtext?: boolean;
};

/** Before a beat, after it, and the stillness kept after an arrival or receipt. */
export const LEAD_MS = 700;
export const TAIL_MS = 1200;
export const HOLD_MS = 1800;
const HOLD_NAMES = /^(arrive|arrival|receipt|result|done)$/i;
const ZOOM_IN_MS = 520;
const ZOOM_HOLD_MS = 2200;

/** Every real beat of a take: its events and marks, with a box in clip px when known. */
export function beatsOf(take: Take): Beat[] {
  const dpr = take.recording.clip.dpr ?? 1;
  const boxOf = (item: { windowBox?: Box; box?: Box }): Box | undefined =>
    item.windowBox ?? (item.box ? scaleBox(item.box, dpr) : undefined);
  const fromEvent = (event: VideoEvent): Beat => {
    const box = boxOf(event);
    const hold = event.beat === "receipt" || event.beat === "result";
    return { t: event.t, ...(box ? { box } : {}), ...(hold ? { hold } : {}) };
  };
  const fromMark = (mark: Mark): Beat => {
    const box = boxOf(mark);
    const hold = mark.cue === "arrive" || HOLD_NAMES.test(mark.name);
    return { t: mark.t, ...(box ? { box } : {}), ...(hold ? { hold } : {}) };
  };
  return [...take.recording.events.map(fromEvent), ...take.marks.map(fromMark)].sort(
    (a, b) => a.t - b.t,
  );
}

function scaleBox(box: Box, scale: number): Box {
  return {
    x: Math.round(box.x * scale),
    y: Math.round(box.y * scale),
    width: Math.round(box.width * scale),
    height: Math.round(box.height * scale),
  };
}

export function mergeSpans(spans: readonly Span[], joinGapMs = 0): Span[] {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span.start <= last.end + joinGapMs) last.end = Math.max(last.end, span.end);
    else out.push({ ...span });
  }
  return out;
}

/**
 * The stretches of a clip to keep. Without --max-idle, all of it. With it, a window around every
 * beat (plus a still hold after arrivals and receipts) is kept, and only a stillness longer than
 * maxIdleMs is cut. The first and last moments always stay so a take opens and lands cleanly.
 */
export function keepSpans(durationMs: number, beats: readonly Beat[], maxIdleMs?: number): Span[] {
  const all = [{ start: 0, end: durationMs }];
  if (!(durationMs > 0)) return [];
  if (maxIdleMs === undefined || !(maxIdleMs >= 0) || beats.length === 0) return all;
  const clamp = (v: number) => Math.max(0, Math.min(durationMs, v));
  const windows = beats.map((beat) => ({
    start: clamp(beat.t - LEAD_MS),
    end: clamp(beat.t + Math.max(TAIL_MS, beat.hold ? HOLD_MS : 0)),
  }));
  windows.push(
    { start: 0, end: clamp(LEAD_MS) },
    { start: clamp(durationMs - TAIL_MS), end: durationMs },
  );
  return mergeSpans(windows, maxIdleMs);
}

/** Lays every take's kept spans end to end on the output clock: hard cuts, in order. */
export function layout(spansByTake: readonly Span[][]): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  spansByTake.forEach((spans, take) => {
    for (const span of spans) {
      out.push({ ...span, take, at });
      at += span.end - span.start;
    }
  });
  return out;
}

export function totalMs(segments: readonly Segment[]): number {
  const last = segments[segments.length - 1];
  return last ? last.at + (last.end - last.start) : 0;
}

/** A clip time of one take on the output clock, or undefined when it was cut. */
export function toOutput(
  segments: readonly Segment[],
  take: number,
  t: number,
): number | undefined {
  const seg = segments.find((s) => s.take === take && t >= s.start && t < s.end);
  return seg ? seg.at + (t - seg.start) : undefined;
}

/** The largest punch-in that never shows a source pixel bigger than an output pixel. */
export function maxZoom(source: Size, out: Size): number {
  const fit = Math.min(out.width / source.width, out.height / source.height);
  return fit >= 1 ? 1 : 1 / fit;
}

/** How far to push in on a box: enough to frame it with room, never past native pixels. */
export function zoomFor(box: Box, source: Size, out: Size): number {
  const want = Math.min(source.width / (box.width * 2.4), source.height / (box.height * 2.4));
  return Math.max(1, Math.min(maxZoom(source, out), want));
}

export type ZoomWindow = { start: number; end: number; z: number; cx: number; cy: number };

/** Punch-ins on one segment, on its local clock (ms from the segment's first frame). */
export function zoomWindows(
  seg: Span,
  beats: readonly Beat[],
  source: Size,
  out: Size,
): ZoomWindow[] {
  const len = seg.end - seg.start;
  const windows: ZoomWindow[] = [];
  for (const beat of beats) {
    if (!beat.box || beat.t < seg.start || beat.t >= seg.end) continue;
    const z = zoomFor(beat.box, source, out);
    if (z <= 1.001) continue;
    const start = Math.max(0, beat.t - seg.start - ZOOM_IN_MS / 2);
    const prev = windows[windows.length - 1];
    if (prev && prev.end > start) prev.end = start;
    windows.push({
      start,
      end: Math.min(len, start + ZOOM_IN_MS * 2 + ZOOM_HOLD_MS),
      z,
      cx: beat.box.x + beat.box.width / 2,
      cy: beat.box.y + beat.box.height / 2,
    });
  }
  return windows.filter((w) => w.end - w.start >= ZOOM_IN_MS);
}

const num = (v: number) => String(Math.round(v * 10000) / 10000);

/** 0→1→0 over a window: eased in, held, eased out (smoothstep, so zero overshoot). */
function weight(w: ZoomWindow, time: string): string {
  const ramp = ZOOM_IN_MS / 1000;
  const a = w.start / 1000;
  const b = w.end / 1000;
  const up = `clip((${time}-${num(a)})/${num(ramp)},0,1)`;
  const down = `clip((${num(b)}-${time})/${num(ramp)},0,1)`;
  const u = `min(${up},${down})`;
  return `(${u}*${u}*(3-2*${u}))`;
}

/** The zoompan filter for a segment, or undefined when it never punches in. */
export function zoompanFilter(
  windows: readonly ZoomWindow[],
  source: Size,
  fit: Size,
  fps: number,
): string | undefined {
  if (!windows.length) return undefined;
  const time = `(on/${fps})`;
  const z = `1${windows.map((w) => `+${num(w.z - 1)}*${weight(w, time)}`).join("")}`;
  const cx = `${num(source.width / 2)}${windows.map((w) => `+${num(w.cx - source.width / 2)}*${weight(w, time)}`).join("")}`;
  const cy = `${num(source.height / 2)}${windows.map((w) => `+${num(w.cy - source.height / 2)}*${weight(w, time)}`).join("")}`;
  const x = `clip((${cx})-iw/zoom/2,0,iw-iw/zoom)`;
  const y = `clip((${cy})-ih/zoom/2,0,ih-ih/zoom)`;
  return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${fit.width}x${fit.height}:fps=${fps}`;
}

const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);

/** The take scaled to fit the output, shrunk only: a small source is padded, never upscaled. */
export function fitSize(source: Size, out: Size): Size {
  const s = Math.min(1, out.width / source.width, out.height / source.height);
  return { width: even(source.width * s), height: even(source.height * s) };
}

/** The score on the output clock: recorded cues, mark cues and a chord on every receipt. */
export function scoreHits(takes: readonly Take[], segments: readonly Segment[]): ScoreHit[] {
  const hits: ScoreHit[] = [];
  takes.forEach((take, index) => {
    const recorded = take.recording.soundCues;
    const cues: (SoundCue | { t: number; kind: "chord" })[] = [
      ...(recorded?.length ? recorded : soundCuesFromEvents(take.recording.events)),
      ...(recorded?.length
        ? []
        : take.marks.flatMap((m) => (m.cue ? [{ t: m.t, kind: m.cue }] : []))),
      ...take.recording.events.flatMap((e) =>
        e.beat === "receipt" || e.beat === "result" ? [{ t: e.t, kind: "chord" as const }] : [],
      ),
    ];
    for (const cue of cues) {
      const t = toOutput(segments, index, cue.t);
      if (t !== undefined) hits.push({ t, kind: hitKind(cue.kind) });
    }
  });
  return hits.sort((a, b) => a.t - b.t);
}

/** Escapes a path for a filter option inside single quotes (`C:\x` → `C\:/x`). */
export function filterPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function takeOf(takes: readonly Take[], seg: Segment): Take {
  const take = takes[seg.take];
  if (!take) throw new Error(`No take ${seg.take} for a segment`);
  return take;
}

function segmentChain(
  seg: Segment,
  index: number,
  takes: readonly Take[],
  o: AssembleOptions,
): string {
  const take = takeOf(takes, seg);
  const clip = take.recording.clip;
  const source = { width: clip.width, height: clip.height };
  const fit = fitSize(source, o);
  const zoom = o.zoom
    ? zoompanFilter(zoomWindows(seg, beatsOf(take), source, o), source, fit, o.fps)
    : undefined;
  const parts = [
    "setpts=PTS-STARTPTS",
    `fps=${o.fps}`,
    zoom ?? `scale=${fit.width}:${fit.height}:flags=lanczos`,
    `pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2:color=0x0B0C0F`,
    "setsar=1",
    "format=yuv420p",
  ];
  return `[${index}:v]${parts.join(",")}[v${index}]`;
}

function endChain(index: number, o: AssembleOptions): string {
  const card = `color=c=0x0B0C0F:s=${o.width}x${o.height}:r=${o.fps}:d=${num((o.endMs ?? 3000) / 1000)}`;
  const files = o.end?.textFiles;
  const size = Math.round(o.height / 24);
  const text = (file: string, y: string, color: string, px: number) =>
    `drawtext=textfile='${filterPath(file)}':fontcolor=${color}:fontsize=${px}:x=(w-text_w)/2:y=${y}`;
  const draws =
    o.drawtext && files
      ? [
          ...(files.cmd ? [text(files.cmd, `h/2-${size}`, "0xF2F3F5", size)] : []),
          ...(files.repo
            ? [
                text(
                  files.repo,
                  `h/2+${Math.round(size * 0.6)}`,
                  "0x8A8F98",
                  Math.round(size * 0.6),
                ),
              ]
            : []),
        ]
      : [];
  return `${[card, ...draws, "setsar=1", "format=yuv420p"].join(",")}[v${index}]`;
}

/** The whole render: one input per kept segment (seeked, so cut stretches are never decoded). */
export function ffmpegArgs(
  takes: readonly Take[],
  segments: readonly Segment[],
  out: string,
  o: AssembleOptions,
): string[] {
  const inputs = segments.flatMap((seg) => [
    "-ss",
    num(seg.start / 1000),
    "-t",
    num((seg.end - seg.start) / 1000),
    "-i",
    takeOf(takes, seg).clip,
  ]);
  const chains = segments.map((seg, i) => segmentChain(seg, i, takes, o));
  const withEnd = o.end ? [...chains, endChain(segments.length, o)] : chains;
  const n = withEnd.length;
  const labels = withEnd.map((_, i) => `[v${i}]`).join("");
  const graph = [...withEnd, `${labels}concat=n=${n}:v=1:a=0[vout]`].join(";");
  const audio = o.audio ? ["-i", o.audio] : [];
  const audioMap = o.audio
    ? ["-map", `${segments.length}:a`, "-c:a", "aac", "-b:a", "128k", "-shortest"]
    : ["-an"];
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...inputs,
    ...audio,
    "-filter_complex",
    graph,
    "-map",
    "[vout]",
    "-c:v",
    "libx264",
    "-preset",
    "superfast",
    "-crf",
    "18",
    "-threads",
    "0",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(o.fps),
    ...audioMap,
    "-movflags",
    "+faststart",
    out,
  ];
}

/** The sidecar every assemble output carries: `house: false` keeps it out of launch films. */
export function assembleMeta(durationMs: number): {
  kind: "walkthrough";
  house: false;
  durationMs: number;
} {
  return { kind: "walkthrough", house: false, durationMs };
}

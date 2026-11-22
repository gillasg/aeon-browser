// The camera: weighted, motivated, never twitchy. One physical curve, zero overshoot, and the
// native-pixel invariant: a source pixel is never drawn larger than one delivery pixel.
import { lockedTime } from "./hold.ts";
import type { CameraCue, HoldRegion, Point, Rect, VideoEvent } from "./types.ts";

export const EASE_MIN_MS = 480;
export const EASE_MAX_MS = 620;
export const EASE_DEFAULT_MS = 540;
/** The window sits on the stage at this fraction of a contain fit. */
export const STAGE_ZOOM = 0.88;
/** Optical push-ins live in this range (times the frame's fill), capped by native pixels. */
export const FOCUS_MIN = 1.25;
export const FOCUS_MAX = 1.85;

/** cubic-bezier(x1, y1, x2, y2) as a pure function of x in [0, 1]. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const bx = (t: number) => 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3;
  const by = (t: number) => 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3;
  const dx = (t: number) =>
    3 * (1 - t) ** 2 * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= (bx(t) - x) / d;
      t = Math.min(1, Math.max(0, t));
    }
    // Bisection polish: Newton can stall near the flat tail of this curve.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24 && Math.abs(bx(t) - x) > 1e-7; i++) {
      if (bx(t) < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return by(t);
  };
}

/** Critically damped: decisive launch, weighted deceleration, dead stop. */
export const ease = cubicBezier(0.16, 1, 0.3, 1);

export const clampEase = (ms: number | undefined) =>
  Math.min(EASE_MAX_MS, Math.max(EASE_MIN_MS, ms ?? EASE_DEFAULT_MS));

export type Size = { width: number; height: number };
/** Where the camera looks (source px) and how far in (`z`, 1 = contain fit of the viewport). */
export type Cam = { cx: number; cy: number; z: number };

/** Source px -> viewport px at z = 1. */
export const fitScale = (src: Size, vp: Size) =>
  Math.min(vp.width / src.width, vp.height / src.height);
/** The largest z that keeps source px >= delivery px. */
export const maxZoom = (src: Size, vp: Size) => 1 / fitScale(src, vp);
/** z that fills the viewport (cover). */
export const coverZoom = (src: Size, vp: Size) =>
  Math.max(vp.width / src.width, vp.height / src.height) / fitScale(src, vp);

function clampCenter(cam: Cam, src: Size, vp: Size): Cam {
  const f = fitScale(src, vp) * cam.z;
  const hw = vp.width / (2 * f);
  const hh = vp.height / (2 * f);
  const cx = hw * 2 >= src.width ? src.width / 2 : Math.min(src.width - hw, Math.max(hw, cam.cx));
  const cy =
    hh * 2 >= src.height ? src.height / 2 : Math.min(src.height - hh, Math.max(hh, cam.cy));
  return { cx, cy, z: cam.z };
}

/** The zoom a focus cue asks for, before the native-pixel cap. */
export function focusZoom(rect: Rect, src: Size, vp: Size): number {
  const f = fitScale(src, vp);
  const fit = Math.min(vp.width / (rect.w * 1.7), vp.height / (rect.h * 1.7)) / f;
  return Math.min(FOCUS_MAX, Math.max(FOCUS_MIN, fit));
}

/** The requested zoom of a cue (uncapped: the linter compares it with maxZoom). */
export function requestedZoom(cue: CameraCue, src: Size, vp: Size): number {
  if (cue.scale !== undefined) return cue.scale;
  if (cue.framing === "stage") return STAGE_ZOOM;
  if (cue.framing === "inside") return coverZoom(src, vp);
  return cue.focusRect ? focusZoom(cue.focusRect, src, vp) : coverZoom(src, vp);
}

export function cueCam(cue: CameraCue | undefined, src: Size, vp: Size, rest: Cam): Cam {
  if (!cue) return rest;
  const z = Math.min(maxZoom(src, vp), requestedZoom(cue, src, vp));
  const r = cue.framing === "focus" ? cue.focusRect : undefined;
  const c = r
    ? { cx: r.x + r.w / 2, cy: r.y + r.h / 2 }
    : { cx: src.width / 2, cy: src.height / 2 };
  return clampCenter({ ...c, z }, src, vp);
}

type Move = { t0: number; ms: number; to: Cam };

function moves(cues: CameraCue[], src: Size, vp: Size, rest: Cam): Move[] {
  const sorted = [...cues].sort((a, b) => a.tStart - b.tStart);
  const out: Move[] = [];
  sorted.forEach((cue, i) => {
    const ms = clampEase(cue.easeMs);
    out.push({ t0: cue.tStart, ms, to: cueCam(cue, src, vp, rest) });
    const next = sorted[i + 1];
    if (!next || next.tStart > cue.tEnd) out.push({ t0: cue.tEnd, ms, to: rest });
  });
  return out;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
function along(m: Move, from: Cam, t: number): Cam {
  const k = ease((t - m.t0) / m.ms);
  return {
    cx: lerp(from.cx, m.to.cx, k),
    cy: lerp(from.cy, m.to.cy, k),
    z: Math.exp(lerp(Math.log(from.z), Math.log(m.to.z), k)),
  };
}

/** The camera at clip time `t`. Inside a hold the camera is locked dead still. */
export function camAt(
  cues: CameraCue[],
  t: number,
  src: Size,
  vp: Size,
  options: { holds?: HoldRegion[]; rest?: "stage" | "inside" } = {},
): Cam {
  const rest = cueCam({ tStart: 0, tEnd: 0, framing: options.rest ?? "inside" }, src, vp, {
    cx: src.width / 2,
    cy: src.height / 2,
    z: 1,
  });
  const time = lockedTime(options.holds ?? [], t);
  let current: { m: Move; from: Cam } | undefined;
  for (const m of moves(cues, src, vp, rest)) {
    if (m.t0 > time) break;
    const from = current ? along(current.m, current.from, m.t0) : rest;
    current = { m, from };
  }
  return current ? along(current.m, current.from, time) : rest;
}

/** CSS placement of the source frame inside a viewport for a camera. */
export function viewTransform(cam: Cam, src: Size, vp: Size) {
  const scale = fitScale(src, vp) * cam.z;
  return { scale, x: vp.width / 2 - cam.cx * scale, y: vp.height / 2 - cam.cy * scale };
}

/** An event's element in source px: window bounds, else page bounds scaled by DPR plus offset. */
export function eventRect(
  e: VideoEvent,
  src: Size & { dpr?: number },
  pageOffset: Point = { x: 0, y: 0 },
): Rect | undefined {
  if (e.windowBox)
    return { x: e.windowBox.x, y: e.windowBox.y, w: e.windowBox.width, h: e.windowBox.height };
  const d = src.dpr ?? 1;
  if (e.box)
    return {
      x: pageOffset.x + e.box.x * d,
      y: pageOffset.y + e.box.y * d,
      w: e.box.width * d,
      h: e.box.height * d,
    };
  const p =
    e.window ??
    (e.page ? { x: pageOffset.x + e.page.x * d, y: pageOffset.y + e.page.y * d } : undefined);
  if (!p) return undefined;
  const w = src.width * 0.4;
  const h = src.height * 0.4;
  return { x: p.x - w / 2, y: p.y - h / 2, w, h };
}

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

function clearOfHolds(cue: CameraCue, holds: HoldRegion[]): CameraCue | undefined {
  let { tStart, tEnd } = cue;
  const ms = clampEase(cue.easeMs);
  for (const h of holds) {
    // A move may not run inside a hold: start before it, or end after it.
    if (tStart + ms > h.tStart && tStart < h.tEnd) tStart = Math.max(0, h.tStart - ms);
    if (tEnd + ms > h.tStart && tEnd < h.tEnd) tEnd = h.tEnd;
  }
  return tEnd > tStart ? { ...cue, tStart, tEnd } : undefined;
}

/**
 * Camera cues motivated only by real events: each click, type or key press with bounds gets a
 * push-in that arrives as the action happens and breathes out after it. Close actions share one
 * move. Moves never start or end inside a hold.
 */
export function fromEvents(
  events: VideoEvent[],
  src: Size & { dpr?: number },
  options: { holds?: HoldRegion[]; pageOffset?: Point; afterMs?: number; mergeMs?: number } = {},
): CameraCue[] {
  const after = options.afterMs ?? 1400;
  const merge = options.mergeMs ?? 700;
  const cues: CameraCue[] = [];
  for (const e of events) {
    if (e.kind !== "click" && e.kind !== "type" && e.kind !== "press") continue;
    const rect = eventRect(e, src, options.pageOffset);
    if (!rect) continue;
    const tStart = Math.max(0, e.t - EASE_DEFAULT_MS);
    const tEnd = e.t + after;
    const prev = cues.at(-1);
    if (prev && tStart - prev.tEnd < merge) {
      const joined = union(prev.focusRect!, rect);
      if (joined.w <= src.width * 0.7 && joined.h <= src.height * 0.7) {
        prev.tEnd = tEnd;
        prev.focusRect = joined;
        continue;
      }
    }
    cues.push({ tStart, tEnd, framing: "focus", focusRect: rect, easeMs: EASE_DEFAULT_MS });
  }
  return cues.flatMap((c) => clearOfHolds(c, options.holds ?? []) ?? []);
}

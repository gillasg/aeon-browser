import type { Box, Zoom } from "./types";

export type Cam = { cx: number; cy: number; scale: number };
const ZOOM_IN = 1000;
const ZOOM_OUT = 900;
const MERGE_GAP = 1600;
type Key = { t: number; cam: Cam; smooth?: boolean };

export function spring(x: number, damping = 0.82): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const wn = 5 / damping;
  const wd = wn * Math.sqrt(1 - damping * damping);
  const s = (k: number) =>
    1 -
    Math.exp(-damping * wn * k) *
      (Math.cos(wd * k) + (damping / Math.sqrt(1 - damping * damping)) * Math.sin(wd * k));
  return s(x) + (1 - s(1)) * x * x * x;
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const center = (b: Box): Point2 => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
type Point2 = { x: number; y: number };

function clampCam(c: Cam, vw: number, vh: number, fw = vw, fh = vh): Cam {
  const scale = Math.max(1, c.scale);
  const hw = fw / (2 * scale);
  const hh = fh / (2 * scale);
  return {
    scale,
    cx: Math.min(vw - hw, Math.max(hw, c.cx)),
    cy: Math.min(vh - hh, Math.max(hh, c.cy)),
  };
}

/** A camera plan from zooms derived from events. Each zoom frames the real action's box. */
export function keyframes(
  zooms: Zoom[],
  vw: number,
  vh: number,
  base: Cam = { cx: vw / 2, cy: vh / 2, scale: 1 },
): Key[] {
  const keys: Key[] = [{ t: 0, cam: base }];
  const sorted = [...zooms].sort((a, b) => a.t0 - b.t0);
  sorted.forEach((z, i) => {
    const prev = keys[keys.length - 1]!;
    const start = Math.max(z.t0, prev.t);
    const from = start > prev.t ? camAt(keys, start) : prev.cam;
    if (start > prev.t) keys.push({ t: start, cam: from });
    const c = center(z.box);
    const reached = start + ZOOM_IN;
    keys.push({ t: reached, cam: clampCam({ cx: c.x, cy: c.y, scale: z.scale }, vw, vh) });
    const hold = Math.max(z.t1, reached);
    if (hold > reached)
      keys.push({ t: hold, cam: clampCam({ cx: c.x, cy: c.y, scale: z.scale }, vw, vh) });
    const next = sorted[i + 1];
    if (!next || next.t0 > hold + MERGE_GAP) keys.push({ t: hold + ZOOM_OUT, cam: base });
  });
  return keys;
}

export function camAt(keys: Key[], t: number): Cam {
  if (t <= keys[0]!.t) return keys[0]!.cam;
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i]!;
    if (t <= b.t) {
      const a = keys[i - 1]!;
      const x = (t - a.t) / Math.max(1, b.t - a.t);
      const k = b.smooth ? x * x * (3 - 2 * x) : spring(x);
      const scale = Math.max(1, Math.exp(lerp(Math.log(a.cam.scale), Math.log(b.cam.scale), k)));
      return { cx: lerp(a.cam.cx, b.cam.cx, k), cy: lerp(a.cam.cy, b.cam.cy, k), scale };
    }
  }
  return keys[keys.length - 1]!.cam;
}

import { camAt, keyframes, spring, type Cam } from "./camera";
import { introMs, toSource, videoDuration } from "./timeline";
import type { Edit, Rect } from "./types";

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease = (x: number) => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};

/** How the source window maps into an area at rest. */
export function framing(edit: Edit, area: Rect): { s0: number; fw: number; fh: number } {
  const { width: vw, height: vh } = edit.source.viewport;
  const s0 = Math.max(area.w / vw, area.h / vh);
  return { s0, fw: area.w / s0, fh: area.h / s0 };
}

export function windowLayout(
  edit: Edit,
  area: Rect,
  band = 0,
): { win: Rect; content: Rect; bar: number } {
  const { viewport } = edit.source;
  const h = area.h - band;
  const short = Math.min(area.w, area.h);
  const pad = edit.style.padding * short;
  const aw = area.w - 2 * pad;
  const ah = h - 2 * pad;
  const aspect = viewport.width / viewport.height;
  let cw = aw;
  let ch = cw / aspect;
  if (ch > ah) {
    cw = ah * aspect;
    ch = ah;
  }
  const x = area.x + (area.w - cw) / 2;
  const y = area.y + (area.h - ch) / 2;
  return { win: { x, y, w: cw, h: ch }, content: { x, y, w: cw, h: ch }, bar: 0 };
}

/** The camera for a source-viewport point, derived from events.json zooms. */
export function camKeys(edit: Edit) {
  const { width: vw, height: vh } = edit.source.viewport;
  const { fw, fh } = framing(edit, { x: 0, y: 0, w: edit.output.width, h: edit.output.height });
  return keyframes(edit.zooms, vw, vh, { cx: fw / 2, cy: fh / 2, scale: 1 });
}

export function camera(edit: Edit, vt: number): Cam {
  return camAt(camKeys(edit), vt);
}

/** Interpolate the drawn cursor at source time st; only events-derived points exist. */
export function cursorAt(cursor: { t: number; x: number; y: number }[], st: number) {
  if (!cursor.length) return undefined;
  let lo = 0;
  let hi = cursor.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cursor[mid]!.t <= st) lo = mid;
    else hi = mid - 1;
  }
  const a = cursor[lo]!;
  const b = cursor[lo + 1];
  if (!b || st <= a.t) return { x: a.x, y: a.y };
  const k = (st - a.t) / Math.max(1, b.t - a.t);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

export function captionBand(edit: Edit, area: Rect): number {
  return edit.overlays.some((o) => o.type === "caption") ? Math.min(area.w, area.h) * 0.09 : 0;
}

export function bandPresence(edit: Edit, st: number): number {
  let k = 0;
  for (const o of edit.overlays) {
    if (o.type !== "caption") continue;
    k = Math.max(k, Math.min(ease((st - (o.t0 - 550)) / 450), ease((o.t1 + 750 - st) / 450)));
  }
  return k;
}

/** Transform that keeps the zoomed point centred and the picture covering the area. */
export function cameraFit(edit: Edit, area: Rect, cam: Cam, band: number) {
  const L = windowLayout(edit, area, band);
  const { width: vw, height: vh } = edit.source.viewport;
  const k = L.content.w / vw;
  const s = Math.max(1, cam.scale);
  const px = L.content.x + cam.cx * k;
  const py = L.content.y + cam.cy * k;
  const focus = { x: area.x, y: area.y, w: area.w, h: area.h - band };
  const ax = px + (focus.x + focus.w / 2 - px) * (1 - 1 / s);
  const ay = py + (focus.y + focus.h / 2 - py) * (1 - 1 / s);
  const fitAxis = (t: number, c0: number, cl: number, a0: number, al: number) => {
    if (s <= 1.001) return t;
    const lo = t + s * c0;
    const len = s * cl;
    if (len >= al) {
      if (lo > a0) t -= lo - a0;
      if (lo + len < a0 + al) t += a0 + al - (lo + len);
    } else t += (a0 + (al - len) / 2 - s * c0 - t) * Math.min(1, (s - 1) / 0.35);
    return t;
  };
  return {
    L,
    s,
    tx: fitAxis(ax - s * px, L.content.x, L.content.w, area.x, area.w),
    ty: fitAxis(ay - s * py, L.content.y, L.content.h, area.y, area.h),
  };
}

export function timeState(props: { edit: Edit }, ms: number) {
  const intro = introMs(props.edit);
  const vlen = videoDuration(props.edit.segments);
  const vt = Math.min(vlen, Math.max(0, ms - intro));
  return { intro, vlen, vt, st: toSource(props.edit.segments, vt) };
}

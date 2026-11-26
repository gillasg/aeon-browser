// Solo -> Pair geometry, and the scanline rule: the page value and the terminal line that returned
// it sit on the same horizontal pixel row. Computed from real bounds; no arrows, no boxes.
import { fitScale, viewTransform, type Cam, type Size } from "./camera.ts";

export const PAIR_BROWSER_SHARE = 0.58;
/** Output-px rectangle. */
export type OutRect = { x: number; y: number; w: number; h: number };

const mix = (a: OutRect, b: OutRect, k: number): OutRect => ({
  x: a.x + (b.x - a.x) * k,
  y: a.y + (b.y - a.y) * k,
  w: a.w + (b.w - a.w) * k,
  h: a.h + (b.h - a.h) * k,
});

/** Browser and terminal rectangles at reveal progress `k` (0 = Solo, 1 = Pair). */
export function pairLayout(out: Size, k: number): { browser: OutRect; terminal: OutRect } {
  const m = Math.round(Math.min(out.width, out.height) * 0.035);
  const solo: OutRect = { x: 0, y: 0, w: out.width, h: out.height };
  const split = Math.round(out.width * PAIR_BROWSER_SHARE);
  const pair: OutRect = { x: m, y: m, w: split - m * 1.5, h: out.height - m * 2 };
  const term: OutRect = {
    x: split + m * 0.5,
    y: m,
    w: out.width - split - m * 1.5,
    h: out.height - m * 2,
  };
  const termStart: OutRect = { ...term, x: term.x + out.width * 0.04 };
  return { browser: mix(solo, pair, k), terminal: mix(termStart, term, k) };
}

/**
 * Terminal top padding (output px) that puts line `line` on the same scanline as source-px row
 * `pageY` of the browser frame. `aligned` is false when the line would have to sit above the
 * pane's top; the pad is then 0 and the editor should start the terminal later in its output.
 */
export function scanlinePad(input: {
  pageY: number;
  cam: Cam;
  src: Size;
  browser: OutRect;
  terminal: OutRect;
  lineHeight: number;
  line: number;
}): { pad: number; aligned: boolean; y: number } {
  const vt = viewTransform(input.cam, input.src, {
    width: input.browser.w,
    height: input.browser.h,
  });
  const y = input.browser.y + vt.y + input.pageY * vt.scale;
  const pad = y - input.terminal.y - input.line * input.lineHeight - input.lineHeight / 2;
  if (pad < 0) return { pad: 0, aligned: false, y };
  return { pad, aligned: true, y };
}

/**
 * The camera with the window's left edge kept in frame: the URL bar and tab strip start there, so
 * a push never crops them. Right-side cropping is allowed when the push is wider than the pane.
 */
export function pairCam(cam: Cam, src: Size, vp: Size): Cam {
  const scale = fitScale(src, vp) * cam.z;
  const w = src.width * scale;
  const minCx = vp.width / 2 / scale; // left edge at x = 0
  const cx = w <= vp.width ? src.width / 2 : Math.min(cam.cx, minCx);
  return { ...cam, cx };
}

/** Monospace size that fits the longest line in the pane with no truncation. */
export function paneFont(out: Size, paneW: number, lines: { text: string }[]): number {
  const base = Math.round(Math.max(out.width, out.height) * 0.0235);
  const longest = Math.max(1, ...lines.map((line) => [...line.text].length));
  // Pane padding is one font size per side; a monospace cell is ~0.6 em wide.
  const fit = Math.floor(paneW / (longest * 0.6 + 2));
  return Math.max(10, Math.min(base, fit));
}

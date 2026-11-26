// Pure helpers for the monochrome dot-matrix theme: the AMOLED palette, a 5×7 bitmap font for
// short display badges (`3×`, `0.4S`, `LEARNED`), and the dot-wave pulse. No React, so tests and
// the linter can use it.

export const INK = {
  void: "#000000",
  primary: "#F3F3F1",
  muted: "#8A8A88",
  hairline: "rgba(243, 243, 241, 0.14)",
  rimTop: "rgba(255, 255, 255, 0.20)",
  /** Only for hand-off indicators. */
  amber: "#F5A623",
} as const;

export const GLYPH_W = 5;
export const GLYPH_H = 7;

// Each glyph is 7 rows; each row is 5 bits, most significant bit on the left.
const FONT: Record<string, number[]> = {
  "0": [14, 17, 19, 21, 25, 17, 14],
  "1": [4, 12, 4, 4, 4, 4, 14],
  "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [31, 2, 4, 2, 1, 17, 14],
  "4": [2, 6, 10, 18, 31, 2, 2],
  "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14],
  "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 2, 12],
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [28, 18, 17, 17, 17, 18, 28],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 17, 25, 21, 19, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  "×": [0, 17, 10, 4, 10, 17, 0],
  ".": [0, 0, 0, 0, 0, 12, 12],
  ":": [0, 12, 12, 0, 12, 12, 0],
  "-": [0, 0, 0, 31, 0, 0, 0],
  "/": [1, 1, 2, 4, 8, 16, 16],
  "%": [24, 25, 2, 4, 8, 19, 3],
  $: [4, 15, 20, 14, 5, 30, 4],
  "·": [0, 0, 0, 12, 12, 0, 0],
  " ": [0, 0, 0, 0, 0, 0, 0],
};

/** Characters the bitmap font can draw (lower case is drawn as upper case). */
export const hasGlyph = (ch: string) => ch.toUpperCase() in FONT;

export type Dot = { x: number; y: number };

/** Lit dots of `text` on a grid (1 unit per dot, 1 unit between glyphs). Unknown glyphs are blank. */
export function glyphDots(text: string): { dots: Dot[]; cols: number; rows: number } {
  const dots: Dot[] = [];
  const chars = [...text.toUpperCase()];
  chars.forEach((ch, i) => {
    const rows = FONT[ch] ?? FONT[" "]!;
    const x0 = i * (GLYPH_W + 1);
    rows.forEach((bits, y) => {
      for (let x = 0; x < GLYPH_W; x++)
        if (bits & (1 << (GLYPH_W - 1 - x))) dots.push({ x: x0 + x, y });
    });
  });
  const cols = Math.max(0, chars.length * (GLYPH_W + 1) - 1);
  return { dots, cols, rows: GLYPH_H };
}

/**
 * A dot's reveal (0..1) at `ms` since a badge appeared: dots light left to right in a quick
 * sweep, so the text resolves column by column instead of fading in as a block.
 */
export function revealAt(ms: number, col: number, cols: number, sweepMs = 360): number {
  const at = (col / Math.max(1, cols)) * sweepMs;
  return Math.max(0, Math.min(1, (ms - at) / 90));
}

/** The quiet wave across the void: opacity of the grid dot at (col,row) at time `ms`. */
export function waveAt(ms: number, col: number, row: number, base = 0.1, lift = 0.18): number {
  const phase = (ms / 1400) * 2 * Math.PI - (col + row) * 0.32;
  return base + lift * Math.max(0, Math.sin(phase)) ** 3;
}

/** Dots along a horizontal scanline from x0 to x1 (output px), `gap` px apart. */
export function scanlineDots(x0: number, x1: number, gap = 8): number[] {
  const a = Math.min(x0, x1);
  const b = Math.max(x0, x1);
  const n = Math.max(0, Math.floor((b - a) / gap));
  return Array.from({ length: n + 1 }, (_, i) => a + i * gap);
}

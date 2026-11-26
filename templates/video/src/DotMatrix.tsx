// The monochrome dot-matrix theme's pieces: bitmap badges, the void's dot field and the scanline
// connector. Pure SVG on #000000: bone-white and grey dots, nothing else.
import React from "react";
import { glyphDots, INK, revealAt, scanlineDots, waveAt } from "./dotmatrix.ts";

/** A short label drawn in 5×7 dots, resolving column by column. */
export const DotText: React.FC<{
  text: string;
  dot: number;
  ms?: number;
  color?: string;
  style?: React.CSSProperties;
}> = ({ text, dot, ms = 1e9, color = INK.primary, style }) => {
  const { dots, cols, rows } = glyphDots(text);
  const pitch = dot * 1.5;
  return (
    <svg
      width={Math.max(1, cols * pitch)}
      height={rows * pitch}
      style={{ display: "block", overflow: "visible", ...style }}
      aria-label={text}
    >
      {dots.map((d, i) => (
        <rect
          key={i}
          x={d.x * pitch}
          y={d.y * pitch}
          width={dot}
          height={dot}
          rx={dot * 0.5}
          fill={color}
          opacity={revealAt(ms, d.x, cols)}
        />
      ))}
    </svg>
  );
};

/** The void's dot field: a sparse grid with a slow diagonal wave. */
export const DotField: React.FC<{ width: number; height: number; ms: number; pitch?: number }> = ({
  width,
  height,
  ms,
  pitch = 24,
}) => {
  const cols = Math.ceil(width / pitch);
  const rows = Math.ceil(height / pitch);
  const dots: React.ReactNode[] = [];
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++)
      dots.push(
        <circle
          key={`${x}.${y}`}
          cx={x * pitch + pitch / 2}
          cy={y * pitch + pitch / 2}
          r={1}
          fill={INK.muted}
          opacity={waveAt(ms, x, y, 0.08, 0.16)}
        />,
      );
  return (
    <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
      {dots}
    </svg>
  );
};

/** A dotted scanline from the page value to the terminal row: one pixel row, end dots brighter. */
export const DotScanline: React.FC<{ x0: number; x1: number; y: number; k: number }> = ({
  x0,
  x1,
  y,
  k,
}) => {
  const xs = scanlineDots(x0, x1, 8);
  const lit = Math.round(xs.length * k);
  return (
    <svg
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}
    >
      {xs.slice(0, lit).map((x, i) => (
        <circle
          key={i}
          cx={x}
          cy={y}
          r={i === 0 || i === xs.length - 1 ? 3 : 1.6}
          fill={i === 0 || i === xs.length - 1 ? INK.primary : INK.muted}
        />
      ))}
    </svg>
  );
};

/** A small dot-matrix badge on a black chip with a 1 px hairline: `3×`, `LEARNED`, `0.4S`. */
export const DotBadge: React.FC<{ text: string; dot: number; ms?: number; amber?: boolean }> = ({
  text,
  dot,
  ms,
  amber,
}) => (
  <div
    style={{
      display: "inline-flex",
      padding: dot * 3,
      background: INK.void,
      borderRadius: dot * 2.5,
      boxShadow: `inset 0 1px 0 ${INK.rimTop}, inset 0 0 0 1px ${INK.hairline}`,
    }}
  >
    <DotText
      text={text}
      dot={dot}
      {...(ms === undefined ? {} : { ms })}
      color={amber ? INK.amber : INK.primary}
    />
  </div>
);

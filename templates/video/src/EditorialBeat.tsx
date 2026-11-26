// A quiet editorial line (five words at most, the linter checks) in negative space, set in the
// 5×7 dot-matrix face when it can be, resolving column by column on the void.
import React from "react";
import { ease } from "./camera.ts";
import { DotText } from "./DotMatrix.tsx";
import { hasGlyph, INK } from "./dotmatrix.ts";
import { SURFACES } from "./Stage.tsx";
import type { EditorialLine, Surface } from "./types.ts";

/** Lines this short and drawable use dots; anything else falls back to the text face. */
export const dotCaption = (text: string) => text.length <= 24 && [...text].every(hasGlyph);

export const EditorialBeat: React.FC<{
  line: EditorialLine;
  t: number;
  surface: Surface;
  width: number;
  height: number;
}> = ({ line, t, surface, width, height }) => {
  if (t < line.tStart || t > line.tEnd) return null;
  const k =
    ease(Math.min(1, (t - line.tStart) / 560)) *
    (1 - ease(Math.max(0, (t - line.tEnd + 480) / 480)));
  const m = Math.round(Math.min(width, height) * 0.05);
  const place = line.placement ?? "bottom-left";
  const ink = surface === "obsidian" ? INK.primary : SURFACES[surface].ink;
  const dot = Math.max(2, Math.round(Math.min(width, height) * 0.0042));
  return (
    <div
      style={{
        position: "absolute",
        ...(place === "top-left" ? { top: m, left: m } : {}),
        ...(place === "bottom-left" ? { bottom: m, left: m } : {}),
        ...(place === "bottom-right" ? { bottom: m, right: m } : {}),
        display: "flex",
        alignItems: "center",
        gap: dot * 4,
        color: ink,
        font: `500 ${Math.round(Math.min(width, height) * 0.034)}px/1.2 -apple-system, "SF Pro Display", Inter, system-ui, sans-serif`,
        letterSpacing: "-0.015em",
        opacity: k,
      }}
    >
      <Constellation dot={dot} ms={t - line.tStart} />
      {dotCaption(line.text) ? (
        <DotText text={line.text} dot={dot} ms={t - line.tStart} color={ink} />
      ) : (
        line.text
      )}
    </div>
  );
};

/** The 2×2 micro-dot mark, calm opacities. */
export const Constellation: React.FC<{ dot: number; ms: number }> = ({ dot, ms }) => {
  const rest = [0.95, 0.36, 0.36, 0.14];
  return (
    <div style={{ display: "grid", gridTemplateColumns: `${dot}px ${dot}px`, gap: dot }}>
      {rest.map((o, i) => (
        <div
          key={i}
          style={{
            width: dot,
            height: dot,
            borderRadius: dot / 2,
            background: INK.primary,
            opacity: o * Math.min(1, Math.max(0, (ms - i * 60) / 120)),
          }}
        />
      ))}
    </div>
  );
};

// A whisper-quiet editorial line (five words at most, the linter checks) in negative space.
import React from "react";
import { ease } from "./camera.ts";
import { SURFACES } from "./Stage.tsx";
import type { EditorialLine, Surface } from "./types.ts";

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
  return (
    <div
      style={{
        position: "absolute",
        ...(place === "top-left" ? { top: m, left: m } : {}),
        ...(place === "bottom-left" ? { bottom: m, left: m } : {}),
        ...(place === "bottom-right" ? { bottom: m, right: m } : {}),
        color: SURFACES[surface].ink,
        font: `500 ${Math.round(Math.min(width, height) * 0.034)}px/1.2 Inter, -apple-system, "SF Pro Display", system-ui, sans-serif`,
        letterSpacing: "-0.015em",
        opacity: k * 0.92,
        transform: `translateY(${(1 - k) * 10}px)`,
      }}
    >
      {line.text}
    </div>
  );
};

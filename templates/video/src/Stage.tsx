// The stage: the AMOLED void (#000000) with a quiet dot field, and the real Chrome window resting
// on it inside a 1 px hairline with a top-lit catchlight. Never a SaaS gradient or a glow.
import React from "react";
import { AbsoluteFill } from "remotion";
import { DotField } from "./DotMatrix.tsx";
import { INK } from "./dotmatrix.ts";
import type { Surface } from "./types.ts";
import type { OutRect } from "./pair.ts";

export const SURFACES: Record<
  Surface,
  { base: string; light: string; ink: string; mute: string; shadow: string; rim: string }
> = {
  obsidian: {
    base: INK.void,
    light: "rgba(255, 255, 255, 0.045)",
    ink: INK.primary,
    mute: INK.muted,
    shadow: `inset 0 1px 0 ${INK.rimTop}`,
    rim: INK.hairline,
  },
  stone: {
    base: "#ECEAE4",
    light: "rgba(255, 255, 255, 0.55)",
    ink: "#141518",
    mute: "rgba(20, 21, 24, 0.55)",
    shadow:
      "0 1px 2px rgba(40,34,26,0.18), 0 14px 30px rgba(40,34,26,0.16), 0 44px 90px rgba(40,34,26,0.2)",
    rim: "rgba(255, 255, 255, 0.7)",
  },
};

/** The surface under everything, lit from above. */
export const StageSurface: React.FC<{
  surface: Surface;
  ms?: number;
  size?: { width: number; height: number };
}> = ({ surface, ms, size }) => {
  const s = SURFACES[surface];
  return (
    <AbsoluteFill
      style={{
        backgroundColor: s.base,
        backgroundImage: `radial-gradient(ellipse 70% 55% at 50% -8%, ${s.light}, transparent 72%)`,
      }}
    >
      {surface === "obsidian" && size && ms !== undefined ? (
        <DotField
          width={size.width}
          height={size.height}
          ms={ms}
          pitch={Math.round(size.width / 64)}
        />
      ) : null}
    </AbsoluteFill>
  );
};

/** The real window at `rect` (viewport px): shadow and rim around real pixels, nothing over them. */
export const StageWindow: React.FC<{
  surface: Surface;
  rect: OutRect;
  radius: number;
  children: React.ReactNode;
}> = ({ surface, rect, radius, children }) => {
  const s = SURFACES[surface];
  return (
    <div
      style={{
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        borderRadius: radius,
        boxShadow: `${s.shadow}, 0 0 0 1px ${s.rim}`,
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
};

/** Luminance-only focus separation (0..0.38): darkens the edges, never blurs a pixel. */
export const FocusDim: React.FC<{ amount: number }> = ({ amount }) =>
  amount <= 0 ? null : (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        background: `radial-gradient(ellipse 62% 58% at 50% 50%, transparent 55%, rgba(0,0,0,${Math.min(0.38, amount)}) 100%)`,
      }}
    />
  );

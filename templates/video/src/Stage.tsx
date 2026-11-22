// The stage: an architectural surface under soft overhead light, and the real Chrome window
// resting on it with a grounded shadow and a 1 px rim catchlight. Never a SaaS gradient.
import React from "react";
import { AbsoluteFill } from "remotion";
import type { Surface } from "./types.ts";
import type { OutRect } from "./pair.ts";

export const SURFACES: Record<
  Surface,
  { base: string; light: string; ink: string; mute: string; shadow: string; rim: string }
> = {
  obsidian: {
    base: "#0B0C0F",
    light: "rgba(255, 246, 232, 0.075)",
    ink: "#E6E8EC",
    mute: "rgba(230, 232, 236, 0.56)",
    shadow: "0 1px 2px rgba(0,0,0,0.55), 0 12px 28px rgba(0,0,0,0.45), 0 48px 96px rgba(0,0,0,0.5)",
    rim: "rgba(255, 255, 255, 0.14)",
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
export const StageSurface: React.FC<{ surface: Surface }> = ({ surface }) => {
  const s = SURFACES[surface];
  return (
    <AbsoluteFill
      style={{
        backgroundColor: s.base,
        backgroundImage: `radial-gradient(ellipse 70% 55% at 50% -8%, ${s.light}, transparent 72%)`,
      }}
    />
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

// A real time-compression cut: the wall clock on both sides, read from the recording.
import React from "react";
import { ease } from "./camera.ts";
import { SURFACES } from "./Stage.tsx";
import { wallClock } from "./timeline.ts";
import type { Surface, TimeCut as Cut } from "./types.ts";

export const TIMECUT_MS = 1400;

export const TimeCut: React.FC<{
  cut: Cut;
  /** Clip time just before the cut (the previous segment's end). */
  before: number;
  startedAt: number;
  /** ms of video since the cut. */
  since: number;
  surface: Surface;
  width: number;
}> = ({ cut, before, startedAt, since, surface, width }) => {
  if (since < 0 || since > TIMECUT_MS) return null;
  const k =
    ease(Math.min(1, since / 480)) * (1 - ease(Math.max(0, (since - TIMECUT_MS + 420) / 420)));
  const s = SURFACES[surface];
  const size = Math.round(width * 0.016);
  const row = (clock: string, detail?: string, strong = false) => (
    <div style={{ color: strong ? s.ink : s.mute }}>
      {clock}
      {detail ? <span style={{ color: s.mute }}>{"  ·  " + detail}</span> : null}
    </div>
  );
  return (
    <div
      style={{
        position: "absolute",
        left: Math.round(width * 0.045),
        bottom: Math.round(width * 0.035),
        font: `500 ${size}px/1.5 ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace`,
        letterSpacing: "0.02em",
        opacity: k,
        transform: `translateY(${(1 - k) * 8}px)`,
      }}
    >
      {row(wallClock(startedAt, before), cut.beforeDetail)}
      {row(wallClock(startedAt, cut.t), cut.afterDetail, true)}
    </div>
  );
};

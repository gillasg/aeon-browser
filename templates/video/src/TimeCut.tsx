// A real time-compression cut: the wall clock on both sides, read from the recording, drawn as
// dot-matrix clocks on a black chip.
import React from "react";
import { ease } from "./camera.ts";
import { DotText } from "./DotMatrix.tsx";
import { INK } from "./dotmatrix.ts";
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
  const dot = Math.max(2, Math.round(width * 0.0021));
  const size = Math.round(width * 0.011);
  const row = (clock: string, detail: string | undefined, strong: boolean, ms: number) => (
    <div style={{ display: "flex", alignItems: "center", gap: dot * 5 }}>
      <DotText text={clock} dot={dot} ms={ms} color={strong ? INK.primary : INK.muted} />
      {detail ? <span style={{ color: s.mute }}>{detail}</span> : null}
    </div>
  );
  return (
    <div
      style={{
        position: "absolute",
        left: Math.round(width * 0.045),
        bottom: Math.round(width * 0.035),
        display: "flex",
        flexDirection: "column",
        gap: dot * 4,
        padding: dot * 5,
        background: INK.void,
        borderRadius: dot * 4,
        boxShadow: `inset 0 1px 0 ${INK.rimTop}, inset 0 0 0 1px ${INK.hairline}`,
        font: `500 ${size}px/1.4 ui-monospace, "SF Mono", Menlo, monospace`,
        opacity: k,
      }}
    >
      {row(wallClock(startedAt, before), cut.beforeDetail, false, since)}
      {row(wallClock(startedAt, cut.t), cut.afterDetail, true, since - 180)}
    </div>
  );
};

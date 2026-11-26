// The last frame: the command an engineer copies, and where it lives, on the void. The 2×2 mark
// opens into a dot constellation behind it. No slogan.
import React from "react";
import { AbsoluteFill } from "remotion";
import { ease } from "./camera.ts";
import { DotField } from "./DotMatrix.tsx";
import { INK } from "./dotmatrix.ts";
import type { EndSpec } from "./types.ts";

export const End: React.FC<{ end: EndSpec; ms: number; width: number; height: number }> = ({
  end,
  ms,
  width,
  height,
}) => {
  const size = Math.round(Math.min(width, height) * 0.042);
  const k = ease(Math.min(1, ms / 560));
  const on = Math.floor(ms / 530) % 2 === 0;
  const dot = Math.max(3, Math.round(size * 0.16));
  const spread = ease(Math.min(1, ms / 900));
  return (
    <AbsoluteFill
      style={{
        backgroundColor: INK.void,
        alignItems: "center",
        justifyContent: "center",
        fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
      }}
    >
      <div style={{ opacity: 0.6 * k }}>
        <DotField width={width} height={height} ms={ms} pitch={Math.round(width / 48)} />
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `${dot}px ${dot}px`,
          gap: dot * (1 + spread),
          marginBottom: size * 1.1,
        }}
      >
        {[0.95, 0.36, 0.36, 0.14].map((o, i) => (
          <div
            key={i}
            style={{
              width: dot,
              height: dot,
              borderRadius: dot / 2,
              background: INK.primary,
              opacity: o * k,
            }}
          />
        ))}
      </div>
      <div
        style={{
          color: INK.primary,
          fontSize: size,
          fontWeight: 500,
          letterSpacing: "-0.01em",
          opacity: k,
        }}
      >
        <span style={{ color: INK.muted }}>$ </span>
        {end.command}
        <span
          style={{
            display: "inline-block",
            width: size * 0.56,
            height: size * 1.05,
            marginLeft: size * 0.12,
            verticalAlign: "text-bottom",
            backgroundColor: INK.primary,
            opacity: on ? 0.9 : 0,
          }}
        />
      </div>
      <div style={{ color: INK.muted, fontSize: size * 0.46, marginTop: size * 0.9, opacity: k }}>
        {end.repo}
      </div>
    </AbsoluteFill>
  );
};

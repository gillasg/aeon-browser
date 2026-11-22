// The last frame: the command an engineer copies, and where it lives. No slogan.
import React from "react";
import { AbsoluteFill } from "remotion";
import { ease } from "./camera.ts";
import type { EndSpec } from "./types.ts";

export const End: React.FC<{ end: EndSpec; ms: number; width: number; height: number }> = ({
  end,
  ms,
  width,
  height,
}) => {
  const size = Math.round(Math.min(width, height) * 0.048);
  const k = ease(Math.min(1, ms / 560));
  const on = Math.floor(ms / 530) % 2 === 0;
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#0B0C0F",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
        opacity: k,
      }}
    >
      <div style={{ color: "#E6E8EC", fontSize: size, fontWeight: 500, letterSpacing: "-0.01em" }}>
        <span style={{ color: "rgba(230,232,236,0.4)" }}>$ </span>
        {end.command}
        <span
          style={{
            display: "inline-block",
            width: size * 0.56,
            height: size * 1.05,
            marginLeft: size * 0.12,
            verticalAlign: "text-bottom",
            backgroundColor: "#E6E8EC",
            opacity: on ? 0.9 : 0,
          }}
        />
      </div>
      <div style={{ color: "rgba(230,232,236,0.5)", fontSize: size * 0.46, marginTop: size * 0.9 }}>
        {end.repo}
      </div>
    </AbsoluteFill>
  );
};

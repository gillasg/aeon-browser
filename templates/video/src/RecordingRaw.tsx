// The raw take: real frames, edge to edge, nothing added. For evals, bug reports and as footage.
import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { Take } from "./recording.ts";

export const RecordingRaw: React.FC<{ take: Take; style?: React.CSSProperties }> = ({
  take,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = take.frameAt((frame * 1000) / fps);
  return (
    <AbsoluteFill style={{ backgroundColor: "#000", ...style }}>
      <Img
        src={staticFile(`frames/${f.file}`)}
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
      />
    </AbsoluteFill>
  );
};

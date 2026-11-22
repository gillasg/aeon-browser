// The honest proof capture: real frames, edge to edge, nothing added. For evals and bug reports.
import React from "react";
import { AbsoluteFill, Img, useCurrentFrame, useVideoConfig } from "remotion";
import { frameAt } from "./timeline.ts";
import type { DirectorEdit } from "./types.ts";

export const RecordingRaw: React.FC<{ edit: DirectorEdit; base: string }> = ({ edit, base }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = frameAt(edit.source.frames, (frame * 1000) / fps);
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {f ? (
        <Img src={base + f.f} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
      ) : null}
    </AbsoluteFill>
  );
};

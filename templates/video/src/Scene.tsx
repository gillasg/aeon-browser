// The blank canvas. Rewrite this file from scratch for every video: it only plays the raw take.
// `take` (src/take.ts) gives real timestamps: take.msToFrame(take.beatTime("receipt") ?? 0).
import React from "react";
import { AbsoluteFill } from "remotion";
import { RecordingRaw } from "./RecordingRaw.tsx";
import { OUTPUT_FPS, take } from "./take.ts";

export const sceneConfig = {
  width: 1920,
  height: 1080,
  fps: OUTPUT_FPS,
  durationInFrames: take.durationInFrames,
};

export const Scene: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: "#000" }}>
    <RecordingRaw take={take} />
  </AbsoluteFill>
);

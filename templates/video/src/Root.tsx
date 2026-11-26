import React from "react";
import { Composition, registerRoot } from "remotion";
import { RecordingRaw } from "./RecordingRaw.tsx";
import { Scene, sceneConfig } from "./Scene.tsx";
import { take } from "./take.ts";

const Root: React.FC = () => (
  <>
    <Composition id="Scene" component={Scene} {...sceneConfig} />
    <Composition
      id="RecordingRaw"
      component={RecordingRaw}
      defaultProps={{ take }}
      width={1920}
      height={1080}
      fps={take.fps}
      durationInFrames={take.durationInFrames}
    />
  </>
);

registerRoot(Root);

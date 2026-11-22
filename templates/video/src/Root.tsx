import React from "react";
import { Composition, registerRoot, staticFile } from "remotion";
import director from "./director.json";
import recording from "./recording.json";
import { DirectorCut } from "./DirectorCut.tsx";
import { RecordingRaw } from "./RecordingRaw.tsx";
import { buildEdit, DIRECTOR_CUT, DIRECTOR_SQUARE, editFrames } from "./edit.ts";
import type { DirectorScript, RecordingEvents } from "./types.ts";

const events = recording as unknown as RecordingEvents;
const script = director as unknown as DirectorScript;
const base = staticFile("frames/");
const cut = buildEdit(events, script, DIRECTOR_CUT);
const square = buildEdit(events, script, DIRECTOR_SQUARE);
const raw = buildEdit(events, { segments: undefined }, DIRECTOR_CUT);
const rawFrames = Math.max(1, Math.ceil((raw.source.durationMs / 1000) * 30));

const Root: React.FC = () => (
  <>
    <Composition
      id="DirectorCut"
      component={DirectorCut}
      defaultProps={{ edit: cut, base }}
      durationInFrames={editFrames(cut)}
      fps={DIRECTOR_CUT.fps}
      width={DIRECTOR_CUT.width}
      height={DIRECTOR_CUT.height}
    />
    <Composition
      id="DirectorSquare"
      component={DirectorCut}
      defaultProps={{ edit: square, base }}
      durationInFrames={editFrames(square)}
      fps={DIRECTOR_SQUARE.fps}
      width={DIRECTOR_SQUARE.width}
      height={DIRECTOR_SQUARE.height}
    />
    {/* Unedited proof: the real frames, full-bleed, no camera, no sound. */}
    <Composition
      id="RecordingRaw"
      component={RecordingRaw}
      defaultProps={{ edit: raw, base }}
      durationInFrames={rawFrames}
      fps={30}
      width={1920}
      height={1080}
    />
  </>
);

registerRoot(Root);

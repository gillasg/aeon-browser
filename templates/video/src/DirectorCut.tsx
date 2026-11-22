// The flagship cut: Stage + Camera + Pair + Holds + TimeCuts + EditorialBeat + End + score.
import React from "react";
import { AbsoluteFill, Audio, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Shot } from "./Camera.tsx";
import { EditorialBeat } from "./EditorialBeat.tsx";
import { End } from "./End.tsx";
import { Pair } from "./Pair.tsx";
import { StageSurface } from "./Stage.tsx";
import { TimeCut } from "./TimeCut.tsx";
import { toSource, toVideo, videoLength } from "./timeline.ts";
import type { DirectorEdit } from "./types.ts";

export type DirectorProps = { edit: DirectorEdit; base: string };

export const DirectorCut: React.FC<DirectorProps> = ({ edit, base }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const vt = (frame * 1000) / fps;
  const picture = videoLength(edit.segments);
  const out = { width, height };
  const audio = edit.audioSrc ? <Audio src={staticFile(edit.audioSrc)} /> : null;
  if (edit.end && vt >= picture)
    return (
      <>
        <End end={edit.end} ms={vt - picture} width={width} height={height} />
        {audio}
      </>
    );
  const t = toSource(edit.segments, vt);
  const paired = edit.pair && t >= edit.pair.pairAtMs;
  return (
    <AbsoluteFill>
      <StageSurface surface={edit.surface} />
      {paired ? (
        <Pair edit={edit} base={base} t={t} out={out} />
      ) : (
        <Shot edit={edit} base={base} t={t} viewport={out} />
      )}
      {edit.timeCuts.map((cut, i) => {
        const at = toVideo(edit.segments, cut.t);
        const prev = edit.segments.filter((s) => s.s1 <= cut.t).at(-1);
        return at === undefined ? null : (
          <TimeCut
            key={i}
            cut={cut}
            before={prev?.s1 ?? cut.t}
            startedAt={edit.source.startedAt}
            since={vt - at}
            surface={edit.surface}
            width={width}
          />
        );
      })}
      {edit.editorial.map((line, i) => (
        <EditorialBeat
          key={i}
          line={line}
          t={t}
          surface={edit.surface}
          width={width}
          height={height}
        />
      ))}
      {audio}
    </AbsoluteFill>
  );
};

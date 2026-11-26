// The flagship cut: Stage + Camera + Pair + Holds + TimeCuts + EditorialBeat + End + score.
import React from "react";
import { AbsoluteFill, Audio, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Shot } from "./Camera.tsx";
import { EditorialBeat } from "./EditorialBeat.tsx";
import { End } from "./End.tsx";
import { Pair } from "./Pair.tsx";
import { StageSurface } from "./Stage.tsx";
import { DotBadge } from "./DotMatrix.tsx";
import { TimeCut } from "./TimeCut.tsx";
import { segmentAt, toSource, toVideo, videoLength } from "./timeline.ts";
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
  // Every speed change wears its label for as long as it plays.
  const seg = segmentAt(edit.segments, vt);
  const dot = Math.max(2, Math.round(width * 0.0024));
  return (
    <AbsoluteFill>
      <StageSurface surface={edit.surface} ms={vt} size={out} />
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
      {seg && seg.speed !== 1 && seg.label ? (
        <div
          style={{
            position: "absolute",
            top: Math.round(width * 0.03),
            right: Math.round(width * 0.03),
          }}
        >
          <DotBadge text={seg.label} dot={dot} />
        </div>
      ) : null}
      {audio}
    </AbsoluteFill>
  );
};

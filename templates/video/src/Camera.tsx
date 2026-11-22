// One shot: the stage surface and the real frame placed by the camera at clip time `t`.
import React from "react";
import { AbsoluteFill, Img } from "remotion";
import { camAt, STAGE_ZOOM, viewTransform, type Size } from "./camera.ts";
import { FocusDim, StageSurface, StageWindow } from "./Stage.tsx";
import { frameAt } from "./timeline.ts";
import type { DirectorEdit } from "./types.ts";

export const Shot: React.FC<{ edit: DirectorEdit; base: string; t: number; viewport: Size }> = ({
  edit,
  base,
  t,
  viewport,
}) => {
  const src = { width: edit.source.width, height: edit.source.height };
  const cam = camAt(edit.cues, t, src, viewport, { holds: edit.holds, rest: "stage" });
  const vt = viewTransform(cam, src, viewport);
  const frame = frameAt(edit.source.frames, t);
  const push = Math.max(0, Math.min(1, (cam.z / STAGE_ZOOM - 1) / 0.5));
  const radius = Math.max(0, 14 * (1 - push)) * Math.min(1, viewport.width / 1920 + 0.4);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <StageSurface surface={edit.surface} />
      <StageWindow
        surface={edit.surface}
        radius={radius}
        rect={{ x: vt.x, y: vt.y, w: src.width * vt.scale, h: src.height * vt.scale }}
      >
        {frame ? (
          <Img
            src={base + frame.f}
            style={{ width: "100%", height: "100%", display: "block", imageRendering: "auto" }}
          />
        ) : null}
      </StageWindow>
      <FocusDim amount={edit.focusDim * push} />
    </AbsoluteFill>
  );
};

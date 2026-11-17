import React from "react";
import { Img } from "remotion";
import { spring } from "./camera";
import { bandPresence, cameraFit, camera, captionBand, cursorAt, timeState } from "./layout";
import { frameAt } from "./timeline";
import type { Rect, RenderProps } from "./types";

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** The arrow: a crisp light pointer with a dark outline so it reads on any page. */
const Arrow: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg
    width={size}
    height={size * 1.25}
    viewBox="0 0 20 25"
    style={{ display: "block", overflow: "visible" }}
  >
    <path
      d="M2 1.5 L2 19.5 L6.6 15.4 L9.6 22.6 L12.9 21.2 L9.9 14.1 L16.1 14.1 Z"
      fill={color}
      stroke={color === "#ffffff" ? "#111827" : "#ffffff"}
      strokeWidth={1.6}
      strokeLinejoin="round"
      style={{ filter: "drop-shadow(0 1.5px 2px rgba(0,0,0,.32))" }}
    />
  </svg>
);

/** One clip's picture: real frames, camera zoom from events, and a cursor drawn only where events
 * put it. A second (side) pane shows only frames: no invented cursor or zoom. */
export const Scene: React.FC<{ props: RenderProps; ms: number; area: Rect; side?: boolean }> = ({
  props,
  ms,
  area,
  side,
}) => {
  const { edit } = props;
  const { vt, st } = timeState(props, ms);
  const band = side ? 0 : captionBand(edit, area) * bandPresence(edit, st);
  const cam = side
    ? { cx: edit.source.viewport.width / 2, cy: edit.source.viewport.height / 2, scale: 1 }
    : camera(edit, vt);
  const { L, s, tx, ty } = cameraFit(edit, area, cam, band);
  const k = L.content.w / edit.source.viewport.width;
  const fr = frameAt(edit.frames, st);
  const cur = side ? undefined : cursorAt(props.cursor, st);
  const cursorPx = Math.max(10, 0.022 * L.content.w);
  const press = (() => {
    if (side) return 1;
    const click = [...props.cursor]
      .reverse()
      .find((c) => c.t <= st && edit.zooms.some((z) => Math.abs(z.t0 - (c.t + 200)) < 400));
    if (!click) return 1;
    const since = st - click.t - 200;
    if (since < 0 || since > 500) return 1;
    return 1 - 0.14 * Math.exp(-12 * (since / 1000)) * Math.cos(20 * (since / 1000));
  })();

  return (
    <div
      style={{
        position: "absolute",
        left: area.x,
        top: area.y,
        width: area.w,
        height: area.h,
        overflow: "hidden",
        background: edit.style.theme === "dark" ? "#0b0b0d" : "#ffffff",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          transformOrigin: "0 0",
          transform: `translate(${tx - area.x}px, ${ty - area.y}px) scale(${s})`,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: L.content.x,
            top: L.content.y,
            width: L.content.w,
            height: L.content.h,
            overflow: "hidden",
            borderRadius: edit.style.radius * (area.w / 1920),
            background: "#fff",
          }}
        >
          {fr && (
            <Img
              src={`${props.base}${fr.f}`}
              style={{ width: "100%", height: "100%", display: "block", objectFit: "cover" }}
            />
          )}
          {cur && (
            <div
              style={{
                position: "absolute",
                left: cur.x * k - cursorPx * 0.1,
                top: cur.y * k - cursorPx * 0.07,
                transform: `scale(${press})`,
                transformOrigin: "10% 6%",
              }}
            >
              <Arrow size={cursorPx} color={edit.style.cursorColor} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export { spring, clamp01 };

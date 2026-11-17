import React from "react";
import { AbsoluteFill, Img, useCurrentFrame, useVideoConfig } from "remotion";
import { ChromeFrame, framedLayout } from "./ChromeFrame";
import { spring } from "./camera";
import { timeState, windowLayout } from "./layout";
import { Scene } from "./Scene";
import { introMs, outroMs, segmentAt, videoDuration } from "./timeline";
import { badgeLabel } from "./presets";
import type { Rect, RenderProps, Style } from "./types";

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const fade = (st: number, t0: number, t1: number, ms = 260) =>
  clamp01((st - t0) / ms) * clamp01((t1 - st) / ms);

/** Backdrop: gradient, colour, or a code-wallpaper (a code screenshot behind the window). */
const Background: React.FC<{ style: Style; height: number; base: string }> = ({
  style,
  height,
  base,
}) => {
  const bg = style.background;
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {bg.type === "image" ? (
        <Img
          src={bg.src.startsWith("run:") ? `${base}${bg.src.slice(4)}` : bg.src}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            filter: bg.blur ? `blur(${bg.blur}px)` : undefined,
            transform: bg.blur ? "scale(1.08)" : undefined,
          }}
        />
      ) : bg.type === "color" ? (
        <AbsoluteFill style={{ background: bg.color }} />
      ) : (
        <AbsoluteFill
          style={{ background: `linear-gradient(${bg.angle ?? 135}deg, ${bg.colors.join(", ")})` }}
        />
      )}
      {style.codeWallpaper && (
        <Img
          src={`${base}${style.codeWallpaper}`}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: 0.5,
            filter: `blur(${Math.round(height / 300)}px) saturate(0.7)`,
          }}
        />
      )}
    </AbsoluteFill>
  );
};

const Card: React.FC<{
  text: string;
  subtitle?: string;
  width: number;
  height: number;
  progress: number;
  style: Style;
}> = ({ text, subtitle, width, height, progress, style }) => {
  const short = Math.min(width, height);
  const e = spring(clamp01(progress / 0.42));
  const e2 = spring(clamp01((progress - 0.1) / 0.42));
  const size = Math.min(short * 0.1, (width * 0.84) / Math.max(1, text.length * 0.55));
  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(6,6,10,.42)",
        backdropFilter: "blur(16px)",
        fontFamily: style.font,
        color: "#fff",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: size,
          fontWeight: 760,
          letterSpacing: "-0.035em",
          lineHeight: 1.04,
          maxWidth: width * 0.86,
          opacity: clamp01(e * 1.3),
          transform: `translateY(${(1 - e) * short * 0.03}px)`,
          textShadow: "0 2px 30px rgba(0,0,0,.3)",
        }}
      >
        {text}
      </div>
      {subtitle && (
        <div
          style={{
            fontSize: short * 0.034,
            marginTop: short * 0.02,
            opacity: clamp01(e2 * 1.3) * 0.82,
          }}
        >
          {subtitle}
        </div>
      )}
    </AbsoluteFill>
  );
};

const Caption: React.FC<{
  text: string;
  opacity: number;
  style: Style;
  width: number;
  height: number;
  y: number;
}> = ({ text, opacity, style, width, height, y }) => {
  const short = Math.min(width, height);
  const fs = short * 0.03 * style.captionFont;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: y - fs,
        display: "flex",
        justifyContent: "center",
        opacity,
      }}
    >
      <div
        style={{
          color: "#fff",
          fontFamily: style.font,
          fontSize: fs,
          fontWeight: 650,
          lineHeight: 1.25,
          maxWidth: width * 0.82,
          textAlign: "center",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          padding: `${fs * 0.4}px ${fs * 0.85}px`,
          borderRadius: fs * 0.55,
          background: "rgba(14,14,18,.92)",
          boxShadow: "0 6px 24px rgba(0,0,0,.3)",
        }}
      >
        {text}
      </div>
    </div>
  );
};

/** The "sped up N×" badge shows only where a segment actually played faster. */
const SpeedBadge: React.FC<{
  speed: number;
  opacity: number;
  width: number;
  height: number;
  style: Style;
}> = ({ speed, opacity, width, height, style }) => {
  const fs = Math.min(width, height) * 0.024;
  return (
    <div
      style={{
        position: "absolute",
        right: width * 0.04,
        top: height * 0.035,
        opacity,
        display: "flex",
        alignItems: "center",
        gap: fs * 0.4,
        background: "#16161b",
        color: "#fff",
        fontFamily: style.font,
        fontWeight: 650,
        fontSize: fs,
        padding: `${fs * 0.35}px ${fs * 0.8}px`,
        borderRadius: 999,
        boxShadow: "0 6px 20px rgba(0,0,0,.3)",
      }}
    >
      <svg width={fs} height={fs * 0.8} viewBox="0 0 22 16">
        <path d="M1 1l9 7-9 7zM12 1l9 7-9 7z" fill="currentColor" />
      </svg>
      {badgeLabel(speed)}
    </div>
  );
};

/** The whole picture at output time `ms`. */
export const VideoAt: React.FC<{
  props: RenderProps;
  ms: number;
  width: number;
  height: number;
}> = ({ props, ms, width, height }) => {
  const { edit } = props;
  const { intro, vlen, vt, st } = timeState(props, ms);
  const area: Rect = { x: 0, y: 0, w: width, h: height };
  const L =
    edit.style.frame && edit.style.frame !== "none"
      ? framedLayout(edit, area)
      : windowLayout(edit, area);
  const capY = (L.win.y + L.win.h + height) / 2;
  const cap = [...edit.overlays]
    .filter((o) => o.type === "caption" && st >= o.t0 - 100 && st <= o.t1 + 300)
    .pop();
  const capOp = cap ? fade(st, cap.t0, cap.t1) : 0;
  const seg = segmentAt(edit.segments, vt);
  const showBadge = seg && seg.speed > 1;
  const badgeOp = showBadge ? clamp01((vlen - vt) / 200) : 0;
  const scene =
    edit.style.frame && edit.style.frame !== "none" ? (
      <ChromeFrame props={props} ms={ms} st={st} area={area} />
    ) : (
      <Scene props={props} ms={ms} area={area} />
    );

  return (
    <AbsoluteFill style={{ width, height, overflow: "hidden" }}>
      <Background style={edit.style} height={height} base={props.base} />
      <AbsoluteFill style={{ opacity: edit.intro ? clamp01((ms - (intro - 300)) / 700) : 1 }}>
        {scene}
      </AbsoluteFill>
      {showBadge && (
        <SpeedBadge
          speed={seg!.speed}
          opacity={badgeOp}
          width={width}
          height={height}
          style={edit.style}
        />
      )}
      {cap && (
        <Caption
          text={cap.text}
          opacity={capOp}
          style={edit.style}
          width={width}
          height={height}
          y={capY}
        />
      )}
      {edit.intro && ms < intro && (
        <AbsoluteFill style={{ opacity: clamp01((intro - ms) / 320) }}>
          <Card
            text={edit.intro.text}
            subtitle={edit.intro.subtitle}
            width={width}
            height={height}
            progress={ms / Math.max(1, edit.intro.duration)}
            style={edit.style}
          />
        </AbsoluteFill>
      )}
      {edit.outro && ms >= intro + vlen && (
        <AbsoluteFill style={{ opacity: clamp01((ms - intro - vlen) / 400) }}>
          <Card
            text={edit.outro.text}
            subtitle={edit.outro.subtitle}
            width={width + 0}
            height={height}
            progress={(ms - intro - vlen) / Math.max(1, edit.outro.duration)}
            style={edit.style}
          />
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

export const Video: React.FC<RenderProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  return <VideoAt props={props} ms={(frame / fps) * 1000} width={width} height={height} />;
};

import React from "react";
import { Composition, registerRoot, staticFile } from "remotion";
import recording from "./recording.json";
import { emptyEdit, OUTPUTS, style } from "./presets";
import { fromEvents } from "./zooms-from-events";
import { Video } from "./Video";
import type { Frame, RecordingEvents, RenderProps, Style, Theme, FrameKind } from "./types";

const events = recording as unknown as RecordingEvents;

/** The whole edit is derived from events.json — the honesty rule lives in fromEvents(). */
export function buildProps(
  outputKey: string,
  options: { theme?: Theme; frame?: FrameKind; layout?: "16x9" | "9x16" | "square" } = {},
): RenderProps {
  const output = OUTPUTS[outputKey] ?? OUTPUTS["16x9"]!;
  const vp = { width: events.clip.width || 1280, height: events.clip.height || 800 };
  const fps = events.clip.fps || 30;
  const derived = fromEvents(events, vp);
  const frames: Frame[] = Array.from({ length: Math.max(1, events.clip.frames || 1) }, (_, i) => ({
    t: (i * 1000) / fps,
    f: `${String(i + 1).padStart(6, "0")}.jpg`,
  }));
  const edit = {
    ...emptyEdit(output, vp, fps),
    frames,
    source: {
      viewport: vp,
      fps,
      duration: events.clip.durationMs,
      mobile: false,
      url: "https://example.com",
    },
    style: style({ theme: options.theme, frame: options.frame }) as Style,
    segments: derived.segments,
    zooms: derived.zooms,
    overlays: derived.captions.map((c) => ({
      type: "caption" as const,
      t0: c.t0,
      t1: c.t1,
      text: c.text,
    })),
    intro: { text: "See it happen", subtitle: "Recorded with Aeon", duration: 1200 },
    outro: { text: "That's it", duration: 1000 },
    badge: derived.segments.some((s) => s.speed > 1) ? { t0: 0, t1: 1000, speed: 4 } : undefined,
  };
  return { edit, base: staticFile("frames/"), cursor: derived.cursor };
}

const durationInFrames = (props: RenderProps) => {
  const { edit } = props;
  const vlen = edit.segments.reduce((sum, s) => sum + (s.s1 - s.s0) / s.speed, 0);
  const total = (edit.intro?.duration ?? 0) + vlen + (edit.outro?.duration ?? 0);
  return Math.max(1, Math.ceil((total / 1000) * edit.output.fps));
};

const Root: React.FC = () => (
  <>
    <Composition
      id="Video"
      component={Video}
      defaultProps={buildProps("16x9")}
      durationInFrames={durationInFrames(buildProps("16x9"))}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="VideoVertical"
      component={Video}
      defaultProps={buildProps("9x16", { frame: "vertical" })}
      durationInFrames={durationInFrames(buildProps("9x16"))}
      fps={30}
      width={1080}
      height={1920}
    />
    <Composition
      id="Square"
      component={Video}
      defaultProps={buildProps("square", { theme: "light" })}
      durationInFrames={durationInFrames(buildProps("square"))}
      fps={30}
      width={1080}
      height={1080}
    />
  </>
);

registerRoot(Root);

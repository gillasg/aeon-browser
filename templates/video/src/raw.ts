// Phone-sized, honest render of a real `aeon record --window` take.
// No title card, no captions, no zooms, no speed badge, no drawn cursor: the real window frames
// (with Aeon's own cursor and the real pointer) fill the picture edge to edge. events.json is still
// read, so the clip's fps/size/duration come from the log rather than being guessed.
import { staticFile } from "remotion";
import recording from "./recording.json";
import { OUTPUTS, style } from "./presets";
import type { Frame, RecordingEvents, RenderProps } from "./types";

export const RAW_FPS = 30; // output frame rate; source frames are mapped by their ms timestamp
export const RAW_MAX_SECONDS = 30;

export function rawProps(): RenderProps {
  const events = recording as unknown as RecordingEvents;
  const vp = { width: events.clip.width || 760, height: events.clip.height || 1350 };
  const fps = events.clip.fps || 30;
  const count = Math.max(
    1,
    Math.min(events.clip.frames || 1, Math.round(RAW_MAX_SECONDS * fps)),
  );
  const frames: Frame[] = Array.from({ length: count }, (_, i) => ({
    t: (i * 1000) / fps,
    f: `${String(i + 1).padStart(6, "0")}.jpg`,
  }));
  const duration = (count / fps) * 1000;
  return {
    base: staticFile("frames/"),
    cursor: [], // never draw a second cursor over a real-window recording
    edit: {
      version: 1,
      source: { viewport: vp, fps, duration, mobile: false },
      output: { ...OUTPUTS["9x16"]!, width: 720, height: 1280, fps: RAW_FPS },
      style: {
        ...style({ theme: "dark", frame: "none" }),
        padding: 0,
        radius: 0,
        background: { type: "color", color: "#000000" },
      },
      frames,
      segments: [{ s0: 0, s1: duration, speed: 1, kind: "action" }],
      zooms: [],
      overlays: [],
    },
  };
}

export function rawDurationInFrames(): number {
  const { edit } = rawProps();
  return Math.max(1, Math.ceil((edit.segments[0]!.s1 / 1000) * RAW_FPS));
}

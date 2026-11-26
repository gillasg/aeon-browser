// Timing helpers over a real take, so a bespoke scene snaps to Chrome's own timestamps in one line:
//   const take = loadRecording(json, { fps: 60 });
//   const hit = take.msToFrame(take.beatTime("receipt") ?? 0);
import type { Beat, FrameRef, Recording, VideoEvent } from "./types.ts";

export type Take = {
  recording: Recording;
  events: VideoEvent[];
  /** Beat events in clip-time order. */
  beats: VideoEvent[];
  durationMs: number;
  /** Output fps (defaults to the capture fps). */
  fps: number;
  captureFps: number;
  width: number;
  height: number;
  frameCount: number;
  durationInFrames: number;
  /** Clip ms → output frame. */
  msToFrame(ms: number): number;
  /** Output frame → clip ms. */
  frameToMs(frame: number): number;
  /** Captured frame index (0-based) → file under frames/, e.g. "000001.jpg". */
  frameFile(index: number): string;
  /** The captured frame showing at clip time `ms`. */
  frameAt(ms: number): FrameRef;
  /** Clip ms of the nth (default first) beat of a kind, else undefined. */
  beatTime(kind: Beat, nth?: number): number | undefined;
};

export const frameFile = (index: number): string =>
  `${String(Math.max(0, Math.floor(index)) + 1).padStart(6, "0")}.jpg`;

export function loadRecording(json: unknown, options: { fps?: number } = {}): Take {
  const recording = json as Recording;
  const clip = recording.clip;
  const captureFps = Math.max(1, clip.fps || 30);
  const frameCount = Math.max(1, clip.frames || 1);
  const durationMs = clip.durationMs || (frameCount / captureFps) * 1000;
  const fps = options.fps ?? captureFps;
  const events = [...(recording.events ?? [])].sort((a, b) => a.t - b.t);
  const beats = events.filter((e) => e.kind === "beat" || e.beat);
  const msToFrame = (ms: number) => Math.max(0, Math.round((ms * fps) / 1000));
  const frameAt = (ms: number): FrameRef => {
    const index = Math.min(frameCount - 1, Math.max(0, Math.floor((ms * captureFps) / 1000)));
    return { index, t: (index * 1000) / captureFps, file: frameFile(index) };
  };
  return {
    recording,
    events,
    beats,
    durationMs,
    fps,
    captureFps,
    width: clip.width,
    height: clip.height,
    frameCount,
    durationInFrames: Math.max(1, Math.ceil((durationMs * fps) / 1000)),
    msToFrame,
    frameToMs: (frame) => (frame * 1000) / fps,
    frameFile,
    frameAt,
    beatTime: (kind, nth = 0) => beats.filter((e) => e.beat === kind)[nth]?.t,
  };
}

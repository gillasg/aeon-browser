// events.json + director.json -> one DirectorEdit per output. Pure, so the linter, the audio
// generator and Remotion all see exactly the same edit.
import { eventRect, fromEvents } from "./camera.ts";
import { holdsAfterBeats } from "./hold.ts";
import { videoLength } from "./timeline.ts";
import type { BeatMark, DirectorEdit, DirectorScript, Frame, RecordingEvents } from "./types.ts";

export const DIRECTOR_CUT = { width: 1920, height: 1080, fps: 30 };
export const DIRECTOR_SQUARE = { width: 1080, height: 1080, fps: 30 };
export const REPO = "github.com/gillasg/aeon-browser";

export function sourceFrames(recording: RecordingEvents): Frame[] {
  const fps = recording.clip.fps || 30;
  return Array.from({ length: Math.max(1, recording.clip.frames || 1) }, (_, i) => ({
    t: (i * 1000) / fps,
    f: `${String(i + 1).padStart(6, "0")}.jpg`,
  }));
}

export function buildEdit(
  recording: RecordingEvents,
  script: DirectorScript = {},
  output: DirectorEdit["output"] = DIRECTOR_CUT,
): DirectorEdit {
  const clip = recording.clip;
  const src = { width: clip.width, height: clip.height, ...(clip.dpr ? { dpr: clip.dpr } : {}) };
  const durationMs = clip.durationMs || (clip.frames / Math.max(1, clip.fps)) * 1000;
  const tagged: BeatMark[] = recording.events.flatMap((e) => {
    if (!e.beat) return [];
    const box = eventRect(e, src);
    return [{ t: e.t, beat: e.beat, ...(box && (e.box || e.windowBox) ? { box } : {}) }];
  });
  const beats = [...tagged, ...(script.beats ?? [])].sort((a, b) => a.t - b.t);
  const holds = script.holds ?? holdsAfterBeats(beats, script.holdMs);
  return {
    version: 1,
    output,
    source: { ...src, startedAt: clip.startedAt, durationMs, frames: sourceFrames(recording) },
    surface: script.surface ?? "obsidian",
    focusDim: Math.min(0.38, Math.max(0, script.focusDim ?? 0.22)),
    cues: script.cues ?? fromEvents(recording.events, src, { holds }),
    holds,
    segments: script.segments ?? [{ s0: 0, s1: durationMs, speed: 1 }],
    editorial: script.editorial ?? [],
    timeCuts: script.timeCuts ?? [],
    beats,
    compile: script.compile ?? [],
    ...(script.pair ? { pair: script.pair } : {}),
    end: script.end ?? { command: "npx aeon-browser", repo: REPO, durationMs: 2400 },
    ...(recording.terminal ? { terminal: recording.terminal } : {}),
    effects: script.effects ?? [],
    slides: script.slides ?? [],
    ...(script.audioSrc ? { audioSrc: script.audioSrc } : {}),
  };
}

/** Picture length + end frame, in ms of video. */
export const editDuration = (edit: DirectorEdit) =>
  videoLength(edit.segments) + (edit.end?.durationMs ?? 0);

export const editFrames = (edit: DirectorEdit) =>
  Math.max(1, Math.ceil((editDuration(edit) / 1000) * edit.output.fps));

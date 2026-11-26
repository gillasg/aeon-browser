// The recording's data model: exactly what `aeon record` writes to events.json (see EVENTS.md).
// Every time below is milliseconds on the clip clock.

export type Point = { x: number; y: number };
/** events.json bounds: CSS px on `box`, captured-window px on `windowBox`. */
export type Box = { x: number; y: number; width: number; height: number };
/** One captured frame: its clip time and its file under frames/. */
export type FrameRef = { index: number; t: number; file: string };

/** The one beat vocabulary, mirrored from apps/cli/src/record-events.ts. */
export const STORY_BEATS = [
  "summon",
  "key",
  "send",
  "teach",
  "learned",
  "receipt",
  "handoff",
  "resume",
  "sound",
  "provenance",
] as const;
export type Beat =
  (typeof STORY_BEATS)[number] | "prompt" | "compile" | "result" | "terminal" | "watch" | "boost";
export type SoundCueKind =
  "start" | "needs-you" | "done" | "key" | "trigger" | "arrive" | "shutter";
export type SoundCue = { t: number; kind: SoundCueKind };

export type VideoEventKind =
  "click" | "type" | "press" | "scroll" | "navigate" | "tab-switch" | "beat";
export type VideoEvent = {
  id: string;
  kind: VideoEventKind;
  t: number;
  at: number;
  tabId?: number;
  page?: Point;
  window?: Point;
  text?: string;
  scroll?: Point;
  box?: Box;
  windowBox?: Box;
  beat?: Beat;
  cue?: string;
  count?: number;
  jsonPath?: string;
  actor?: "director";
};
export type ClipMeta = {
  file: string;
  source: "window" | "screen" | "tabs";
  width: number;
  height: number;
  fps: number;
  startedAt: number;
  durationMs: number;
  frames: number;
  tabId?: number;
  dpr?: number;
  logicalWidth?: number;
  logicalHeight?: number;
  dropped?: number;
  dup?: number;
  clean?: boolean;
  settings?: Record<string, string | number | boolean>;
};
export type Alignment = {
  text: string;
  via: "provenance" | "text" | "none";
  aligned: boolean;
  box?: Box;
  jsonPath?: string;
  line?: number;
};
/** One chunk of a terminal cast. `in` is the command. */
export type TerminalEvent = { t: number; kind: "in" | "out" | "err"; text: string };
export type TerminalCast = {
  version: 1;
  command: string;
  startedAt: number;
  events: TerminalEvent[];
};
export type RecordingEvents = {
  version: 1;
  recorder: "aeon";
  clock: "clip";
  clip: ClipMeta;
  clips?: ClipMeta[];
  events: VideoEvent[];
  terminal?: TerminalCast;
  soundCues?: SoundCue[];
  align?: Alignment;
  note?: string;
};

/** The recording a scene is built from (events.json). */
export type Recording = RecordingEvents;

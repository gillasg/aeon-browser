// The kit's data model. `RecordingEvents` is exactly what `aeon record` writes to events.json
// (see EVENTS.md). `DirectorEdit` is an editor's decisions on top of it, built by edit.ts.
// Every time below is milliseconds on the clip clock unless a name says `video`.

export type Point = { x: number; y: number };
/** events.json bounds: CSS px on `box`, captured-window px on `windowBox`. */
export type Box = { x: number; y: number; width: number; height: number };
/** The kit's rectangles, always in source-frame px unless noted. */
export type Rect = { x: number; y: number; w: number; h: number };
export type Frame = { t: number; f: string };

export type Beat =
  "prompt" | "teach" | "compile" | "receipt" | "result" | "terminal" | "watch" | "boost";
export type SoundCueKind = "start" | "needs-you" | "done" | "key" | "trigger";
export type SoundCue = { t: number; kind: SoundCueKind };

export type VideoEventKind = "click" | "type" | "press" | "scroll" | "navigate" | "tab-switch";
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
};
/** One chunk of a terminal cast. `t` is ms on the clip clock. `in` is the command. */
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
  note?: string;
};

// ---- Director's decisions ----------------------------------------------------------------------

export type Surface = "obsidian" | "stone";
export type Framing = "stage" | "inside" | "focus";

/** One camera beat. `focus` pushes into `focusRect` (source px); `scale` overrides the fit. */
export type CameraCue = {
  tStart: number;
  tEnd: number;
  framing: Framing;
  focusRect?: Rect;
  scale?: number;
  easeMs?: number;
};
/** Protected stillness: no camera move, cut or speed change may start inside it. */
export type HoldRegion = { tStart: number; tEnd: number };
/** A kept stretch of the clip. Gaps between segments are cuts. `speed !== 1` needs a `label`. */
export type Segment = { s0: number; s1: number; speed: number; label?: string };
export type Placement = "top-left" | "bottom-left" | "bottom-right";
export type EditorialLine = { tStart: number; tEnd: number; text: string; placement?: Placement };
/** A real time-compression cut at clip time `t`; clocks come from the recording, never typed in. */
export type TimeCut = { t: number; beforeDetail?: string; afterDetail?: string };
/** A beat-bearing element and where it sits in the source frame at `t`. */
export type BeatMark = { t: number; beat: Beat; box?: Rect };
export type PairSpec = {
  /** Clip time the browser glides left and the terminal emerges. */
  pairAtMs: number;
  /** Source-px y of the page value to line up with (an events.json `box.y`, scaled). */
  alignPageY?: number;
  /** Index of the terminal line that should sit on that scanline. */
  alignTerminalLine?: number;
};
export type EndSpec = { command: string; repo: string; durationMs: number };

export type DirectorEdit = {
  version: 1;
  output: { width: number; height: number; fps: number };
  source: {
    width: number;
    height: number;
    dpr?: number;
    startedAt: number;
    durationMs: number;
    frames: Frame[];
  };
  surface: Surface;
  focusDim: number;
  cues: CameraCue[];
  holds: HoldRegion[];
  segments: Segment[];
  editorial: EditorialLine[];
  timeCuts: TimeCut[];
  beats: BeatMark[];
  compile: { tStart: number; tEnd: number }[];
  pair?: PairSpec;
  end?: EndSpec;
  terminal?: TerminalCast;
  /** Declared visual effects. The linter refuses blur, tilt, glow and overshoot. */
  effects: string[];
  /** Full-screen title or stat cards. Always refused by the linter; kept so it can say so. */
  slides: { text: string; durationMs: number }[];
  audioSrc?: string;
  lint?: "on" | "off";
};

/** director.json: what an author writes. Everything is optional; events.json fills the rest. */
export type DirectorScript = Partial<
  Pick<
    DirectorEdit,
    | "surface"
    | "focusDim"
    | "cues"
    | "holds"
    | "segments"
    | "editorial"
    | "timeCuts"
    | "beats"
    | "compile"
    | "pair"
    | "end"
    | "effects"
    | "slides"
    | "audioSrc"
  >
> & { holdMs?: number };

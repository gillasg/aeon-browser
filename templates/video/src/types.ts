// The kit's data model. `RecordingEvents` is exactly what `aeon record` writes to events.json;
// the other types are an editor's decisions, derived from it by edit-from-events.ts.

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type Frame = { t: number; f: string; sy?: number };
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
};
/** The on-disk log. Import it from src/recording.json (copied from the recording folder). */
export type RecordingEvents = {
  version: 1;
  recorder: "aeon";
  clock: "clip";
  clip: ClipMeta;
  clips?: ClipMeta[];
  events: VideoEvent[];
  note?: string;
};

export type Theme = "light" | "dark";
export type FrameKind = "none" | "horizontal" | "vertical";
export type Output = { width: number; height: number; fps: number; preset: string };
export type Background =
  | { type: "gradient"; colors: string[]; angle?: number }
  | { type: "color"; color: string }
  | { type: "image"; src: string; blur?: number };

export type Style = {
  theme: Theme;
  frame: FrameKind;
  background: Background;
  padding: number;
  radius: number;
  accent: string;
  font: string;
  captionFont: number;
  codeWallpaper?: string;
  cursorColor: string;
};

export type Segment = { s0: number; s1: number; speed: number; kind: "action" | "hold" | "slack" };
export type Zoom = { t0: number; t1: number; box: Box; scale: number };
export type Overlay =
  | { type: "caption"; t0: number; t1: number; text: string }
  | { type: "keys"; t0: number; t1: number; text: string };
export type Card = { text: string; subtitle?: string; duration: number };

/** One clip's timeline: source frames and the edit decisions on top of them. */
export type Edit = {
  version: 1;
  source: {
    viewport: { width: number; height: number };
    fps: number;
    duration: number;
    mobile: boolean;
    url?: string;
  };
  output: Output;
  style: Style;
  frames: Frame[];
  segments: Segment[];
  zooms: Zoom[];
  overlays: Overlay[];
  intro?: Card;
  outro?: Card;
  badge?: { t0: number; t1: number; speed: number };
  /** A second clip (e.g. the chat), shown beside the first in a split frame. */
  side?: { frames: Frame[]; viewport: { width: number; height: number }; title?: string };
};

/** Props every composition receives. `frames` come from staticFile()'d public/frames/. */
export type RenderProps = {
  edit: Edit;
  base: string;
  /** The drawn cursor and zoom path, derived only from events.json. */
  cursor: { t: number; x: number; y: number }[];
};

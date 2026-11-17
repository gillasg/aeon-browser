import type { Edit, Output, Style, Theme, FrameKind } from "./types";

export const FONT = '"Inter Variable", Inter, "Segoe UI", system-ui, sans-serif';

/** House style: clean, readable on a phone. Light or dark, horizontal or vertical Chrome tabs. */
export function style(
  options: { theme?: Theme; frame?: FrameKind; accent?: string; codeWallpaper?: string } = {},
): Style {
  const theme = options.theme ?? "dark";
  const dark = theme === "dark";
  return {
    theme,
    frame: options.frame ?? "horizontal",
    background: dark
      ? { type: "gradient", colors: ["#0f172a", "#1e1b4b", "#312e81"], angle: 150 }
      : { type: "gradient", colors: ["#eef2f7", "#dbeafe", "#e0e7ff"], angle: 150 },
    padding: 0.07,
    radius: 18,
    accent: options.accent ?? (dark ? "#38bdf8" : "#2563eb"),
    font: FONT,
    captionFont: 1,
    codeWallpaper: options.codeWallpaper,
    cursorColor: dark ? "#ffffff" : "#141418",
  };
}

export const OUTPUTS: Record<string, Output> = {
  "16x9": { width: 1920, height: 1080, fps: 30, preset: "16x9" },
  "9x16": { width: 1080, height: 1920, fps: 30, preset: "9x16" },
  square: { width: 1080, height: 1080, fps: 30, preset: "square" },
};

export function emptyEdit(output: Output, viewport = { width: 1280, height: 800 }, fps = 30): Edit {
  return {
    version: 1,
    source: { viewport, fps, duration: 0, mobile: false },
    output,
    style: style(),
    frames: [],
    segments: [],
    zooms: [],
    overlays: [],
  };
}

/** The "sped up N×" badge is honest: it only appears where a segment really played faster. */
export function badgeLabel(speed: number): string {
  return `sped up ${Math.round(speed)}×`;
}

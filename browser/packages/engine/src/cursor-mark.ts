// The one cursor mark, and the colours the page shadow paints with. Pages do not load
// tokens.css, so this module inlines the same values. They stay dark on every site.

export const CURSOR_PATH =
  "M 1.2 1.2 L 23.2 9.2 L 17.2 7.3 L 18.7 10.5 L 13.9 8.8 L 15.1 12 L 11.3 9.7 L 14.2 13 L 10.9 12.3 L 13.4 16.8 L 10 15.9 L 12.9 21.5 Z";

export const CURSOR_VIEWBOX = "0 0 25 23";
export const CURSOR_WIDTH = 22;
export const CURSOR_HEIGHT = 20;
export const IBEAM_PATH = "M2 1.5h8M2 20.5h8M6 1.5v19";

/** Neutral edge glow. Also the badge colour when the product has no colour of its own. */
export const NEUTRAL_GLOW = "#8b93a7";
export const NEEDS_BADGE = "#e08a00";
export const BADGE_FALLBACK = "#4f46e5";

export const CURSOR_MARK = {
  path: CURSOR_PATH,
  viewBox: CURSOR_VIEWBOX,
  width: CURSOR_WIDTH,
  height: CURSOR_HEIGHT,
  ibeam: IBEAM_PATH,
  ibeamViewBox: "0 0 12 22",
  ibeamWidth: 12,
  ibeamHeight: 22,
  neutralGlow: NEUTRAL_GLOW,
};

/** Island and cursor custom properties. Values match the block at the end of tokens.css. */
export const CURSOR_VARS: Readonly<Record<string, string>> = {
  "--aeon-cursor": "#9fd4ff",
  "--aeon-cursor-stroke": "#142033",
  "--aeon-cursor-shadow": "rgb(0 0 0 / 35%)",
  "--aeon-island-bg": "rgb(17 24 39 / 92%)",
  "--aeon-island-bg-solid": "rgb(17 24 39 / 97%)",
  "--aeon-island-surface": "#1c1b25",
  "--aeon-island-ink": "#ffffff",
  "--aeon-island-text": "#eeeef4",
  "--aeon-island-raise": "#e4e2ee",
  "--aeon-island-chip": "#cfcbdc",
  "--aeon-island-muted": "#8f8b9e",
  "--aeon-island-faint": "#6f6b80",
  "--aeon-island-line": "rgb(255 255 255 / 8%)",
  "--aeon-island-line-strong": "rgb(255 255 255 / 12%)",
  "--aeon-island-wash": "rgb(255 255 255 / 8%)",
  "--aeon-island-wash-5": "rgb(255 255 255 / 5%)",
  "--aeon-island-wash-10": "rgb(255 255 255 / 10%)",
  "--aeon-island-wash-strong": "rgb(255 255 255 / 16%)",
  "--aeon-island-wash-24": "rgb(255 255 255 / 24%)",
  "--aeon-island-spin": "rgb(255 255 255 / 30%)",
  "--aeon-island-field": "rgb(255 255 255 / 22%)",
  "--aeon-island-ink-soft": "rgb(255 255 255 / 85%)",
  "--aeon-island-focus": "rgb(255 255 255 / 80%)",
  "--aeon-island-ripple-fill": "rgb(255 255 255 / 35%)",
  "--aeon-island-needs": NEEDS_BADGE,
  "--aeon-island-needs-soft": "#e5b567",
  "--aeon-island-needs-hot": "#ffb347",
  "--aeon-island-needs-ink": "#7a4a00",
  "--aeon-island-needs-line": "rgb(224 138 0 / 95%)",
  "--aeon-island-done": "#2f3b2d",
  "--aeon-island-error": "#5a2f2c",
  "--aeon-island-shadow": "rgb(0 0 0 / 25%)",
  "--aeon-island-shadow-deep": "rgb(0 0 0 / 60%)",
  "--aeon-island-scrim": "rgb(10 8 20 / 55%)",
  "--aeon-island-glow": NEUTRAL_GLOW,
  "--aeon-island-glow-line": "rgb(139 147 167 / 85%)",
  "--aeon-island-glow-mid": "rgb(139 147 167 / 50%)",
  "--aeon-island-glow-soft": "rgb(139 147 167 / 22%)",
  "--aeon-island-spot": "rgb(15 23 42 / 55%)",
  "--aeon-island-callout": "#111827",
  "--aeon-island-callout-shadow": "rgb(0 0 0 / 30%)",
  "--aeon-island-ripple": "rgb(17 24 39 / 55%)",
  "--aeon-island-keys": "rgb(17 24 39 / 90%)",
  "--aeon-island-ring": "rgb(99 102 241 / 90%)",
  "--aeon-island-trail": "rgb(99 102 241 / 55%)",
  "--aeon-island-badge": BADGE_FALLBACK,
  "--aeon-island-dot": "#d4d4d8",
  "--aeon-fs-xs": "11px",
  "--aeon-fs-sm": "12px",
  "--aeon-fs-md": "13px",
  "--aeon-r-8": "8px",
  "--aeon-r-md": "10px",
  "--aeon-r-12": "12px",
  "--aeon-r-14": "14px",
  "--aeon-r-18": "18px",
  "--aeon-r-full": "999px",
  "--aeon-r-half": "50%",
};

export const CURSOR_TOKEN_CSS =
  ":host{" +
  Object.entries(CURSOR_VARS)
    .map(([name, value]) => name + ":" + value)
    .join(";") +
  "}";

/** Ease-out cubic along the same bent quadratic the engine cursor has always used. */
export function glideDuration(distance: number): number {
  return Math.min(520, 140 + distance * 0.45);
}

export function glidePoint(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  t: number,
): { x: number; y: number } {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const distance = Math.hypot(dx, dy);
  const bend = Math.min(80, distance * 0.18);
  const cx = fromX + dx / 2 - (dy / (distance || 1)) * bend;
  const cy = fromY + dy / 2 + (dx / (distance || 1)) * bend;
  const eased = 1 - Math.pow(1 - t, 3);
  const rest = 1 - eased;
  return {
    x: rest * rest * fromX + 2 * rest * eased * cx + eased * eased * toX,
    y: rest * rest * fromY + 2 * rest * eased * cy + eased * eased * toY,
  };
}

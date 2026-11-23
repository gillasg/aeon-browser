// The one cursor mark, and the colours the page shadow paints with. Pages do not load
// tokens.css, so this module inlines the same values. They stay dark on every site.

/**
 * A clean stemless pointer: the classic vertical-left OS arrow head without its tail. Bone fill,
 * a black outline, so it reads on light and dark pages. Its nose is at (1.2, 1.2).
 */
export const CURSOR_PATH = "M 1.2 1.2 L 1.2 17.4 L 5.6 13.2 L 12.6 13.2 Z";

export const CURSOR_VIEWBOX = "0 0 14 19";
export const CURSOR_WIDTH = 15;
export const CURSOR_HEIGHT = 20;
export const IBEAM_PATH = "M2 1.5h8M2 20.5h8M6 1.5v19";

/** Neutral edge glow. Also the badge colour when the product has no colour of its own. */
export const NEUTRAL_GLOW = "#ecebe8";
export const NEEDS_BADGE = "#c9a46a";
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
  "--aeon-cursor": "#ecebe8",
  "--aeon-cursor-stroke": "#000000",
  "--aeon-cursor-shadow": "rgb(236 235 232 / 20%)",
  "--aeon-island-bg": "#16161aeb",
  "--aeon-island-bg-solid": "#16161aeb",
  "--aeon-island-surface": "#1e1e23",
  "--aeon-island-ink": "#ecebe8",
  "--aeon-island-text": "#ecebe8",
  "--aeon-island-raise": "#ecebe8",
  "--aeon-island-chip": "#ecebe8a3",
  "--aeon-island-muted": "#ecebe8a3",
  "--aeon-island-faint": "#ecebe866",
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
  "--aeon-island-focus": "rgb(236 235 232 / 60%)",
  "--aeon-island-ripple-fill": "rgb(236 235 232 / 16%)",
  "--aeon-island-needs": "#16161aeb",
  "--aeon-island-needs-soft": "#c9a46a",
  "--aeon-island-needs-hot": "#ecebe8",
  "--aeon-island-needs-ink": "#ecebe8",
  "--aeon-island-needs-line": "rgb(201 164 106 / 70%)",
  "--aeon-island-done": "#16161aeb",
  "--aeon-island-error": "#16161aeb",
  "--aeon-island-shadow": "rgb(0 0 0 / 25%)",
  "--aeon-island-shadow-deep": "rgb(0 0 0 / 60%)",
  "--aeon-island-scrim": "transparent",
  "--aeon-island-glow": "#ecebe8",
  "--aeon-island-glow-line": "rgb(236 235 232 / 40%)",
  "--aeon-island-glow-mid": "rgb(236 235 232 / 14%)",
  "--aeon-island-glow-soft": "rgb(236 235 232 / 6%)",
  "--aeon-island-spot": "transparent",
  "--aeon-island-callout": "#16161aeb",
  "--aeon-island-callout-shadow": "rgb(0 0 0 / 30%)",
  "--aeon-island-ripple": "rgb(236 235 232 / 40%)",
  "--aeon-island-keys": "#16161aeb",
  "--aeon-island-ring": "rgb(236 235 232 / 55%)",
  "--aeon-island-trail": "rgb(236 235 232 / 30%)",
  "--aeon-island-badge": BADGE_FALLBACK,
  "--aeon-island-dot": "#ecebe8a3",
  "--aeon-island-rec": "#ecebe8a3",
  "--aeon-island-edge": "inset 0 0 0 1px #ffffff1f, 0 0 0 1px #0000004d",
  "--aeon-island-elev":
    "inset 0 0 0 1px #ffffff1f, 0 0 0 1px #0000004d, 0 8px 28px #00000040, 0 1px 3px #00000033",
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

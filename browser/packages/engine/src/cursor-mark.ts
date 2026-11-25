// The one cursor mark, and the colours the page shadow paints with. Pages do not load
// tokens.css, so this module inlines the same values. AMOLED obsidian on every site.

/**
 * A clean stemless pointer: the classic vertical-left OS arrow head without its tail. Pure black
 * obsidian fill, a 1.25px bone specular outline and a soft drop shadow, no inner dot, so it reads
 * on light and dark pages. Its nose is at (1.8, 1.8).
 */
export const CURSOR_PATH = "M 1.8 1.8 L 1.8 18.2 L 6.3 13.9 L 13.4 13.9 Z";

export const CURSOR_VIEWBOX = "0 0 15 20";
export const CURSOR_WIDTH = 16;
export const CURSOR_HEIGHT = 21;
export const IBEAM_PATH = "M2 1.5h8M2 20.5h8M6 1.5v19";

/** Neutral edge glow. Also the badge colour when the product has no colour of its own. */
export const NEUTRAL_GLOW = "#ecebe8";
export const NEEDS_BADGE = "#f5a623";
export const BADGE_FALLBACK = "#f3f3f1";

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
  "--aeon-cursor": "#000000",
  "--aeon-cursor-stroke": "rgb(243 243 241 / 90%)",
  "--aeon-cursor-shadow": "rgb(0 0 0 / 55%)",
  "--aeon-island-bg":
    "radial-gradient(125% 95% at 50% 0%, rgb(255 255 255 / 5.5%) 0%, rgb(255 255 255 / 0%) 56%), #000000",
  "--aeon-island-bg-solid": "#000000",
  "--aeon-island-surface":
    "radial-gradient(125% 95% at 50% 0%, rgb(255 255 255 / 5.5%) 0%, rgb(255 255 255 / 0%) 56%), #000000",
  "--aeon-island-ink": "#f3f3f1",
  "--aeon-island-text": "#f3f3f1",
  "--aeon-island-raise": "#f3f3f1",
  "--aeon-island-chip": "rgb(243 243 241 / 56%)",
  "--aeon-island-muted": "rgb(243 243 241 / 38%)",
  "--aeon-island-faint": "rgb(243 243 241 / 34%)",
  "--aeon-island-line": "rgb(255 255 255 / 6.5%)",
  "--aeon-island-line-strong": "rgb(255 255 255 / 12%)",
  "--aeon-island-wash": "rgb(255 255 255 / 8%)",
  "--aeon-island-wash-5": "rgb(255 255 255 / 5%)",
  "--aeon-island-wash-10": "rgb(255 255 255 / 10%)",
  "--aeon-island-wash-strong": "rgb(255 255 255 / 16%)",
  "--aeon-island-wash-24": "rgb(255 255 255 / 24%)",
  "--aeon-island-spin": "rgb(255 255 255 / 30%)",
  "--aeon-island-field": "rgb(255 255 255 / 22%)",
  "--aeon-island-ink-soft": "rgb(255 255 255 / 85%)",
  "--aeon-island-focus": "rgb(243 243 241 / 60%)",
  "--aeon-island-ripple-fill": "rgb(236 235 232 / 16%)",
  "--aeon-island-needs":
    "radial-gradient(125% 95% at 50% 0%, rgb(255 255 255 / 5.5%) 0%, rgb(255 255 255 / 0%) 56%), #000000",
  "--aeon-island-needs-soft": "#f5a623",
  "--aeon-island-needs-hot": "rgb(245 166 35 / 14%)",
  "--aeon-island-needs-ink": "#f5a623",
  "--aeon-island-needs-line": "rgb(245 166 35 / 36%)",
  "--aeon-island-done":
    "radial-gradient(125% 95% at 50% 0%, rgb(255 255 255 / 5.5%) 0%, rgb(255 255 255 / 0%) 56%), #000000",
  "--aeon-island-error":
    "radial-gradient(125% 95% at 50% 0%, rgb(255 255 255 / 5.5%) 0%, rgb(255 255 255 / 0%) 56%), #000000",
  "--aeon-island-shadow": "rgb(0 0 0 / 25%)",
  "--aeon-island-shadow-deep": "rgb(0 0 0 / 60%)",
  "--aeon-island-scrim": "transparent",
  "--aeon-island-glow": "#ecebe8",
  "--aeon-island-glow-line": "rgb(236 235 232 / 40%)",
  "--aeon-island-glow-mid": "rgb(236 235 232 / 14%)",
  "--aeon-island-glow-soft": "rgb(236 235 232 / 6%)",
  "--aeon-island-spot": "transparent",
  "--aeon-island-callout":
    "radial-gradient(125% 95% at 50% 0%, rgb(255 255 255 / 5.5%) 0%, rgb(255 255 255 / 0%) 56%), #000000",
  "--aeon-island-callout-shadow": "rgb(0 0 0 / 30%)",
  "--aeon-island-ripple": "rgb(236 235 232 / 40%)",
  "--aeon-island-keys": "#000000",
  "--aeon-island-ring": "rgb(236 235 232 / 55%)",
  "--aeon-island-trail": "rgb(236 235 232 / 30%)",
  "--aeon-island-badge": "#f3f3f1",
  "--aeon-island-dot": "#f3f3f1",
  "--aeon-island-rec": "#ecebe8a3",
  "--aeon-island-edge":
    "inset 0 1px 0 rgb(255 255 255 / 20%), inset 0 0 0 1px rgb(255 255 255 / 11%), 0 0 0 1px rgb(0 0 0 / 92%)",
  "--aeon-island-elev":
    "inset 0 1px 0 rgb(255 255 255 / 20%), inset 0 0 0 1px rgb(255 255 255 / 11%), 0 0 0 1px rgb(0 0 0 / 92%), 0 26px 76px rgb(0 0 0 / 88%), 0 8px 24px rgb(0 0 0 / 65%)",
  "--aeon-island-needs-rim":
    "inset 0 1px 0 rgb(245 166 35 / 34%), inset 0 0 0 1px rgb(245 166 35 / 28%), 0 0 0 1px rgb(0 0 0 / 92%), 0 26px 76px rgb(0 0 0 / 88%), 0 0 32px rgb(245 166 35 / 10%)",
  "--aeon-island-rim":
    "inset 0 1px 0 rgb(255 255 255 / 20%), inset 0 0 0 1px rgb(255 255 255 / 11%)",
  "--aeon-island-spring": "440ms cubic-bezier(0.22, 1, 0.36, 1)",
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

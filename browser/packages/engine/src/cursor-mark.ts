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
  "--graft-cursor": "#000000",
  "--graft-cursor-stroke": "rgb(243 243 241 / 90%)",
  "--graft-cursor-shadow": "rgb(0 0 0 / 55%)",
  "--graft-island-bg":
    "radial-gradient(125% 95% at 50% 0%, rgb(255 255 255 / 5.5%) 0%, rgb(255 255 255 / 0%) 56%), #000000",
  "--graft-island-bg-solid": "#000000",
  "--graft-island-surface":
    "radial-gradient(125% 95% at 50% 0%, rgb(255 255 255 / 5.5%) 0%, rgb(255 255 255 / 0%) 56%), #000000",
  "--graft-island-ink": "#f3f3f1",
  "--graft-island-text": "#f3f3f1",
  "--graft-island-raise": "#f3f3f1",
  "--graft-island-chip": "rgb(243 243 241 / 56%)",
  "--graft-island-muted": "rgb(243 243 241 / 38%)",
  "--graft-island-faint": "rgb(243 243 241 / 34%)",
  "--graft-island-line": "rgb(255 255 255 / 6.5%)",
  "--graft-island-line-strong": "rgb(255 255 255 / 12%)",
  "--graft-island-wash": "rgb(255 255 255 / 8%)",
  "--graft-island-wash-5": "rgb(255 255 255 / 5%)",
  "--graft-island-wash-10": "rgb(255 255 255 / 10%)",
  "--graft-island-wash-strong": "rgb(255 255 255 / 16%)",
  "--graft-island-wash-24": "rgb(255 255 255 / 24%)",
  "--graft-island-spin": "rgb(255 255 255 / 30%)",
  "--graft-island-field": "rgb(255 255 255 / 22%)",
  "--graft-island-ink-soft": "rgb(255 255 255 / 85%)",
  "--graft-island-focus": "rgb(243 243 241 / 60%)",
  "--graft-island-ripple-fill": "rgb(236 235 232 / 16%)",
  "--graft-island-needs":
    "radial-gradient(125% 95% at 50% 0%, rgb(255 255 255 / 5.5%) 0%, rgb(255 255 255 / 0%) 56%), #000000",
  "--graft-island-needs-soft": "#f5a623",
  "--graft-island-needs-hot": "rgb(245 166 35 / 14%)",
  "--graft-island-needs-ink": "#f5a623",
  "--graft-island-needs-line": "rgb(245 166 35 / 36%)",
  "--graft-island-done":
    "radial-gradient(125% 95% at 50% 0%, rgb(255 255 255 / 5.5%) 0%, rgb(255 255 255 / 0%) 56%), #000000",
  "--graft-island-error":
    "radial-gradient(125% 95% at 50% 0%, rgb(255 255 255 / 5.5%) 0%, rgb(255 255 255 / 0%) 56%), #000000",
  "--graft-island-shadow": "rgb(0 0 0 / 25%)",
  "--graft-island-shadow-deep": "rgb(0 0 0 / 60%)",
  "--graft-island-scrim": "transparent",
  "--graft-island-glow": "#ecebe8",
  "--graft-island-glow-line": "rgb(236 235 232 / 40%)",
  "--graft-island-glow-mid": "rgb(236 235 232 / 14%)",
  "--graft-island-glow-soft": "rgb(236 235 232 / 6%)",
  "--graft-island-spot": "transparent",
  "--graft-island-callout":
    "radial-gradient(125% 95% at 50% 0%, rgb(255 255 255 / 5.5%) 0%, rgb(255 255 255 / 0%) 56%), #000000",
  "--graft-island-callout-shadow": "rgb(0 0 0 / 30%)",
  "--graft-island-ripple": "rgb(236 235 232 / 40%)",
  "--graft-island-keys": "#000000",
  "--graft-island-ring": "rgb(236 235 232 / 55%)",
  "--graft-island-trail": "rgb(236 235 232 / 30%)",
  "--graft-island-badge": "#f3f3f1",
  "--graft-island-dot": "#f3f3f1",
  "--graft-island-rec": "#ecebe8a3",
  "--graft-island-edge":
    "inset 0 1px 0 rgb(255 255 255 / 20%), inset 0 0 0 1px rgb(255 255 255 / 11%), 0 0 0 1px rgb(0 0 0 / 92%)",
  "--graft-island-elev":
    "inset 0 1px 0 rgb(255 255 255 / 20%), inset 0 0 0 1px rgb(255 255 255 / 11%), 0 0 0 1px rgb(0 0 0 / 92%)",
  "--graft-island-rim":
    "inset 0 1px 0 rgb(255 255 255 / 20%), inset 0 0 0 1px rgb(255 255 255 / 11%)",
  "--graft-island-spring": "440ms cubic-bezier(0.22, 1, 0.36, 1)",
  "--graft-fs-xs": "11px",
  "--graft-fs-sm": "12px",
  "--graft-fs-md": "13px",
  "--graft-r-8": "8px",
  "--graft-r-md": "10px",
  "--graft-r-12": "12px",
  "--graft-r-14": "14px",
  "--graft-r-18": "18px",
  "--graft-r-full": "999px",
  "--graft-r-half": "50%",
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

/** The one overlay's host marker: the orb host carries it, and the page painter defers to it. */
export const UNIFIED_OVERLAY_ATTR = "data-graft-overlay";

/**
 * Where the working pill goes so it never sits on what the agent is about to click or type into.
 * `pill` is the pill's box, `target` the point or box being acted on, `view` the viewport (all in
 * viewport pixels). Returns the viewport corner farthest from the target when the pill comes
 * within `margin` pixels of it, or "" when the pill is already clear.
 */
export function pillDodge(
  pill: { x: number; y: number; w: number; h: number },
  target: { x: number; y: number; w?: number; h?: number },
  view: { w: number; h: number },
  margin?: number,
): string {
  const gap = typeof margin === "number" ? margin : 48;
  const tw = target.w || 0;
  const th = target.h || 0;
  const clear =
    pill.x > target.x + tw + gap ||
    pill.x + pill.w < target.x - gap ||
    pill.y > target.y + th + gap ||
    pill.y + pill.h < target.y - gap;
  if (clear) return "";
  const vertical = target.y + th / 2 < view.h / 2 ? "bottom" : "top";
  const horizontal = target.x + tw / 2 < view.w / 2 ? "right" : "left";
  return vertical + "-" + horizontal;
}

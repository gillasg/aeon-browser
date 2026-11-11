import { CURSOR_TOKEN_CSS } from "@browserkit/engine/cursor-mark";

// The orb's own layer: the hit target, the pill and the ask box frame. The glyph itself is the
// shared page cursor, so this layer does not draw a second one. Island colours come from the
// cursor token group, which does not follow the page theme.
const LAYER_STYLE = `
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
.spot {
  position: fixed; inset: 0; pointer-events: none; opacity: 0;
  transition: opacity .5s ease;
}
.spot.on { opacity: 1; }
.hit {
  all: unset; position: fixed; left: 0; top: 0; width: 32px; height: 32px;
  border-radius: var(--aeon-r-full); pointer-events: auto; cursor: grab; will-change: transform;
}
.hit:active { cursor: grabbing; }
.hit:focus-visible { outline: 2px solid var(--aeon-island-focus); outline-offset: -4px; }
.pill {
  position: fixed; left: 0; top: 0; display: flex; align-items: center; gap: 8px;
  max-width: 360px; padding: 5px 5px 5px 12px; box-sizing: border-box;
  border-radius: var(--aeon-r-full); pointer-events: auto; white-space: nowrap;
  will-change: transform; font: 500 var(--aeon-fs-md)/17px system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--aeon-island-ink); background: var(--aeon-island-bg);
  box-shadow: 0 6px 18px var(--aeon-island-shadow); transition: opacity .3s ease;
}
.pill[hidden] { display: none; }
.pill.fading { opacity: 0; }
.pill[data-state="needs"] { background: var(--aeon-island-needs); }
.pill[data-state="done"] { background: var(--aeon-island-done); }
.pill[data-state="error"] { background: var(--aeon-island-error); }
.pill .label {
  all: unset; cursor: pointer; overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.pill .spin {
  width: 11px; height: 11px; flex: none; border-radius: var(--aeon-r-full); box-sizing: border-box;
  border: 2px solid var(--aeon-island-spin); border-top-color: var(--aeon-island-ink);
  animation: spin .8s linear infinite;
}
.pill:not([data-state="thinking"]):not([data-state="working"]) .spin { display: none; }
.pill:not([data-state="thinking"]):not([data-state="working"]):not([data-state="needs"]) .stop { display: none; }
@keyframes spin { to { transform: rotate(360deg); } }
.pill .ic {
  all: unset; width: 24px; height: 24px; flex: none; border-radius: var(--aeon-r-full);
  display: grid; place-items: center; cursor: pointer; background: var(--aeon-island-line-strong);
  font: 600 var(--aeon-fs-xs)/1 system-ui, sans-serif; color: var(--aeon-island-ink);
}
.pill .ic:hover { background: var(--aeon-island-wash-24); }
.pill .ic:focus-visible, .pill .label:focus-visible {
  outline: 2px solid var(--aeon-island-focus); outline-offset: 2px;
}
iframe {
  position: fixed; left: 0; top: 0; border: 0; background: transparent;
  pointer-events: auto; color-scheme: normal; opacity: 0;
  transform: scale(.2); transform-origin: 0 0;
  transition: opacity .3s ease, transform .45s cubic-bezier(.3, 1.3, .5, 1);
}
iframe.on { opacity: 1; transform: none; }
iframe.off { visibility: hidden; }
@media (prefers-reduced-motion: reduce) {
  iframe, .spot, .pill { transition: none; }
  .pill .spin { animation: none; }
}
:host([data-reduced-motion]) iframe, :host([data-reduced-motion]) .spot,
:host([data-reduced-motion]) .pill { transition: none; }
:host([data-reduced-motion]) .pill .spin { animation: none; }
`;

export const OVERLAY_STYLE = ":host { all: initial; }" + CURSOR_TOKEN_CSS + LAYER_STYLE;

export function spotlightGradient(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): string {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rx = box.width * 0.9 + 40;
  const ry = box.height + 40;
  return `radial-gradient(ellipse ${rx}px ${ry}px at ${cx}px ${cy}px, transparent 60%, var(--aeon-island-scrim) 100%)`;
}

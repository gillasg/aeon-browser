// Styles for the overlay, scoped inside its closed shadow root so pages cannot restyle it. The
// engine draws the agent's cursor while it acts and the edge glow; the overlay draws the same
// cursor while it is summoned or between steps, its pill and its box.
export const OVERLAY_STYLE = `
:host { all: initial; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
.cursor {
  position: fixed; left: 0; top: 0; width: 18px; height: 20px; pointer-events: none;
  will-change: transform; opacity: 1; transition: opacity .25s ease;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .35));
}
.cursor.away { opacity: 0; }
.spot {
  position: fixed; inset: 0; pointer-events: none; opacity: 0;
  transition: opacity .5s ease;
}
.spot.on { opacity: 1; }
.hit {
  all: unset; position: fixed; left: 0; top: 0; width: 32px; height: 32px; border-radius: 50%;
  pointer-events: auto; cursor: grab; will-change: transform;
}
.hit:active { cursor: grabbing; }
.hit:focus-visible { outline: 2px solid rgba(255, 255, 255, .8); outline-offset: -4px; }
.pill {
  position: fixed; left: 0; top: 0; display: flex; align-items: center; gap: 8px;
  max-width: 360px; padding: 5px 5px 5px 12px; box-sizing: border-box; border-radius: 999px;
  pointer-events: auto; white-space: nowrap; will-change: transform;
  font: 500 12.5px/17px system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff;
  background: rgba(17, 24, 39, .92); box-shadow: 0 6px 18px rgba(0, 0, 0, .25);
  transition: opacity .3s ease;
}
.pill[hidden] { display: none; }
.pill.fading { opacity: 0; }
.pill[data-state="needs"] { background: #e08a00; }
.pill[data-state="done"] { background: #2f3b2d; }
.pill[data-state="error"] { background: #5a2f2c; }
.pill .label {
  all: unset; cursor: pointer; overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.pill .spin {
  width: 11px; height: 11px; flex: none; border-radius: 50%; box-sizing: border-box;
  border: 2px solid rgba(255, 255, 255, .3); border-top-color: #fff;
  animation: spin .8s linear infinite;
}
.pill:not([data-state="thinking"]):not([data-state="working"]) .spin { display: none; }
.pill:not([data-state="thinking"]):not([data-state="working"]):not([data-state="needs"]) .stop { display: none; }
@keyframes spin { to { transform: rotate(360deg); } }
.pill .ic {
  all: unset; width: 24px; height: 24px; flex: none; border-radius: 50%; display: grid;
  place-items: center; cursor: pointer; background: rgba(255, 255, 255, .12);
  font: 600 11px/1 system-ui, sans-serif;
}
.pill .ic:hover { background: rgba(255, 255, 255, .24); }
.pill .ic:focus-visible, .pill .label:focus-visible { outline: 2px solid rgba(255, 255, 255, .8); outline-offset: 2px; }
iframe {
  position: fixed; left: 0; top: 0; border: 0; background: transparent;
  pointer-events: auto; color-scheme: normal; opacity: 0;
  transform: scale(.2); transform-origin: 0 0;
  transition: opacity .3s ease, transform .45s cubic-bezier(.3, 1.3, .5, 1);
}
iframe.on { opacity: 1; transform: none; }
iframe.off { visibility: hidden; }
@media (prefers-reduced-motion: reduce) {
  iframe, .spot, .cursor, .pill { transition: none; }
  .pill .spin { animation: none; }
}
:host([data-reduced-motion]) iframe, :host([data-reduced-motion]) .spot,
:host([data-reduced-motion]) .cursor, :host([data-reduced-motion]) .pill { transition: none; }
:host([data-reduced-motion]) .pill .spin { animation: none; }
`;

/** The cursor itself: a plain white pointer without a stem (the engine draws the same one). */
export const CURSOR_PATH = "M1.5 1.5 L1.5 16.5 L13.5 9.5 Z";

export function spotlightGradient(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): string {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return `radial-gradient(ellipse ${box.width * 0.9 + 40}px ${box.height + 40}px at ${cx}px ${cy}px, transparent 60%, rgba(10, 8, 20, .55) 100%)`;
}

// Styles for the overlay, scoped inside its closed shadow root so pages cannot restyle it. The
// engine draws the agent's cursor and the edge glow; the orb draws only the swarm and its box.
export const OVERLAY_STYLE = `
:host { all: initial; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
canvas {
  position: fixed; inset: 0; pointer-events: none; opacity: 1;
  transition: opacity .35s ease;
}
canvas.away { opacity: 0; }
.spot {
  position: fixed; inset: 0; pointer-events: none; opacity: 0;
  transition: opacity .5s ease;
}
.spot.on { opacity: 1; }
.hit {
  all: unset; position: fixed; left: 0; top: 0; width: 64px; height: 64px; border-radius: 50%;
  pointer-events: auto; cursor: grab; will-change: transform;
}
.hit:active { cursor: grabbing; }
.hit:focus-visible { outline: 2px solid rgba(124, 92, 255, .7); outline-offset: -8px; }
.pill {
  all: unset; position: fixed; left: 0; top: 0; max-width: 240px; padding: 5px 11px;
  border-radius: 999px; pointer-events: auto; cursor: pointer; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; box-sizing: border-box;
  font: 550 12px/16px system-ui, -apple-system, "Segoe UI", sans-serif; color: #1b1830;
  background: rgba(255, 255, 255, .78); backdrop-filter: blur(18px) saturate(1.6);
  box-shadow: 0 8px 22px -12px rgba(0, 0, 0, .45), 0 0 0 1px rgba(20, 16, 40, .1);
}
.pill[hidden] { display: none; }
.pill::before {
  content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 7px;
  border-radius: 50%; background: #7c5cff; vertical-align: 1px;
}
.pill[data-state="needs"]::before { background: #e08a00; }
.pill[data-state="done"]::before, .pill[data-state="paused"]::before,
.pill[data-state="error"]::before { background: #9a98a8; }
.pill:focus-visible { outline: 2px solid rgba(124, 92, 255, .7); outline-offset: 2px; }
@media (prefers-color-scheme: dark) {
  .pill { color: #f1f0f6; background: rgba(34, 33, 44, .78); box-shadow: 0 8px 22px -12px rgba(0, 0, 0, .6), 0 0 0 1px rgba(255, 255, 255, .1); }
}
iframe {
  position: fixed; left: 0; top: 0; border: 0; background: transparent;
  pointer-events: auto; color-scheme: normal; opacity: 0;
  transform: scale(.2); transform-origin: 0 100%;
  transition: opacity .3s ease, transform .45s cubic-bezier(.3, 1.3, .5, 1);
}
iframe.on { opacity: 1; transform: none; }
iframe.off { visibility: hidden; }
@media (prefers-reduced-motion: reduce) {
  iframe, .spot, canvas { transition: none; }
}
:host([data-reduced-motion]) iframe, :host([data-reduced-motion]) .spot,
:host([data-reduced-motion]) canvas { transition: none; }
`;

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

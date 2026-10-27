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

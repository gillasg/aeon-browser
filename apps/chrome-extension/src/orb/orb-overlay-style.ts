// Styles for the overlay, scoped inside its closed shadow root so pages cannot restyle it.
export const OVERLAY_STYLE = `
:host { all: initial; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
canvas { position: fixed; inset: 0; pointer-events: none; }
.spot {
  position: fixed; inset: 0; pointer-events: none; opacity: 0;
  transition: opacity .5s ease;
}
.spot.on { opacity: 1; }
.cursor {
  position: fixed; left: 0; top: 0; pointer-events: none; opacity: 0;
  transition: opacity .3s ease; will-change: transform;
}
.cursor.on { opacity: 1; }
.cursor svg { display: block; filter: drop-shadow(0 0 6px rgba(124, 92, 255, .8)); }
.label {
  position: absolute; left: 18px; top: 18px; white-space: nowrap;
  background: #7c5cff; color: #fff; border-radius: 999px; padding: 3px 10px;
  font: 600 11.5px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 4px 14px rgba(40, 20, 120, .35);
}
.ring {
  position: fixed; width: 10px; height: 10px; margin: -7px 0 0 -7px; border-radius: 50%;
  border: 2px solid #7c5cff; pointer-events: none; opacity: 0;
}
.ring.go { animation: ring .6s ease-out; }
@keyframes ring {
  from { opacity: 1; transform: scale(1); }
  to { opacity: 0; transform: scale(4.6); }
}
iframe {
  position: fixed; left: 0; top: 0; border: 0; background: transparent;
  pointer-events: auto; color-scheme: normal; opacity: 0;
  transform: scale(.2); transform-origin: 100% 100%;
  transition: opacity .3s ease, transform .45s cubic-bezier(.3, 1.3, .5, 1);
}
iframe.on { opacity: 1; transform: none; }
iframe.off { visibility: hidden; }
@media (prefers-reduced-motion: reduce) {
  iframe, .spot, .cursor { transition: none; }
  .ring.go { animation: none; }
}
`;

export const CURSOR_SVG = `<svg width="20" height="24" viewBox="0 0 20 24" aria-hidden="true">
<path d="M2 2 L2 19 L7 14.5 L10.5 22 L13.5 20.6 L10 13.3 L17 13.3 Z" fill="#7c5cff"
 stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

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

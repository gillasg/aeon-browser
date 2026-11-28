import { CURSOR_TOKEN_CSS } from "@browserkit/engine/cursor-mark";

// The orb's own layer: the hit target, the pill and the ask box frame. Never a page dim or blur:
// only the box itself is glass. The glyph itself is the
// shared page cursor, so this layer does not draw a second one. Island colours come from the
// cursor token group, which does not follow the page theme.
const LAYER_STYLE = `
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
.hit {
  all: unset; position: fixed; left: 0; top: 0; width: 32px; height: 32px;
  border-radius: var(--graft-r-full); pointer-events: auto; cursor: default; will-change: transform;
}
/* While a run drives the page or the box is open, the hit target is gone: no stray pointer. */
:host([data-run]) .hit, :host([data-open]) .hit { display: none; }
.hit:focus-visible { outline: 2px solid var(--graft-island-focus); outline-offset: -4px; }
.pill {
  position: fixed; left: 0; top: 0; display: flex; align-items: center; gap: 8px;
  max-width: 360px; padding: 5px 5px 5px 12px; box-sizing: border-box;
  border-radius: 18px; pointer-events: none; white-space: nowrap;
  will-change: transform; transition: transform .28s ease, opacity .3s ease; font: 500 var(--graft-fs-md)/17px -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif;
  color: var(--graft-island-ink); background: var(--graft-island-bg);
  -webkit-backdrop-filter: none; backdrop-filter: none;
  box-shadow: var(--graft-island-elev);
}
.pill .label, .pill .ic { pointer-events: auto; }
.pill[hidden] { display: none; }
.pill.fading { opacity: 0; }
.pill .label {
  all: unset; cursor: pointer; overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.pill .spin {
  flex: none; display: inline-grid; grid-template-columns: 3px 3px; gap: 3px;
}
.pill .spin i {
  width: 3px; height: 3px; border-radius: 50%; background: var(--graft-island-dot);
  opacity: .14; animation: ink-wave 1.4s ease-in-out infinite;
}
.pill .spin i:nth-child(2) { animation-delay: .18s; }
.pill .spin i:nth-child(4) { animation-delay: .36s; }
.pill .spin i:nth-child(3) { animation-delay: .54s; }
.pill:not([data-state="thinking"]):not([data-state="working"]) .spin { display: none; }
.pill:not([data-state="thinking"]):not([data-state="working"]):not([data-state="needs"]) .stop { display: none; }
.pill.hold-layout:not([data-state="thinking"]):not([data-state="working"]) .spin { display: inline-grid; visibility: hidden; }
.pill.hold-layout:not([data-state="thinking"]):not([data-state="working"]):not([data-state="needs"]) .stop { display: grid; visibility: hidden; pointer-events: none; }
@keyframes ink-wave { 0%, 100% { opacity: .14; } 40% { opacity: .95; } }
.pill .ic {
  all: unset; width: 24px; height: 24px; flex: none; border-radius: var(--graft-r-full);
  display: grid; place-items: center; cursor: pointer; background: var(--graft-island-line-strong);
  font: 500 var(--graft-fs-xs)/1 -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif; color: var(--graft-island-ink);
}
.pill .ic:hover { background: var(--graft-island-wash-24); }
.pill .ic:focus-visible, .pill .label:focus-visible {
  outline: 2px solid var(--graft-island-focus); outline-offset: 2px;
}
iframe {
  position: fixed; left: 0; top: 0; border: 0; background: transparent;
  pointer-events: auto; color-scheme: normal; opacity: 0;
  transform: scale(.2); transform-origin: 0 0;
  transition: opacity .3s ease, transform .45s cubic-bezier(.3, 1.3, .5, 1);
}
iframe.on { opacity: 1; transform: none; }
iframe.off {
  visibility: hidden;
  transition: opacity .2s ease, transform .2s ease, visibility 0s linear .2s;
}
@media (prefers-reduced-motion: reduce) {
  iframe, .pill { transition: none; }
  .pill .spin i { animation: none; }
}
:host([data-reduced-motion]) iframe, :host([data-reduced-motion]) .pill { transition: none; }
:host([data-reduced-motion]) .pill .spin i { animation: none; }
`;

export const OVERLAY_STYLE = ":host { all: initial; }" + CURSOR_TOKEN_CSS + LAYER_STYLE;

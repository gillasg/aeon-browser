import { CURSOR_TOKEN_CSS } from "@browserkit/engine/cursor-mark";

// The orb's own layer: the hit target, the pill and the ask box frame. Never a page dim or blur:
// only the box itself is glass. The glyph itself is the
// shared page cursor, so this layer does not draw a second one. Island colours come from the
// cursor token group, which does not follow the page theme.
const LAYER_STYLE = `
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
.hit {
  all: unset; position: fixed; left: 0; top: 0; width: 32px; height: 32px;
  border-radius: var(--graft-r-full); pointer-events: auto; cursor: grab; will-change: transform;
}
.hit:active { cursor: grabbing; }
.hit:focus-visible { outline: 2px solid var(--graft-island-focus); outline-offset: -4px; }
.pill {
  position: fixed; left: 0; top: 0; display: flex; align-items: center; gap: 8px;
  max-width: 360px; padding: 5px 5px 5px 12px; box-sizing: border-box;
  border-radius: var(--graft-r-full); pointer-events: auto; white-space: nowrap;
  will-change: transform; font: 500 var(--graft-fs-md)/17px -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif;
  color: var(--graft-island-ink); background: var(--graft-island-bg);
  -webkit-backdrop-filter: none; backdrop-filter: none;
  box-shadow: var(--graft-island-elev); transition: opacity .3s ease;
}
.pill[hidden] { display: none; }
.pill.fading { opacity: 0; }
.pill .label {
  all: unset; cursor: pointer; overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.pill .spin {
  width: 9px; height: 9px; flex: none; border-radius: var(--graft-r-full); box-sizing: border-box;
  border: 1px solid var(--graft-island-ink-soft); animation: ink-breathe 2.4s ease-in-out infinite alternate;
}
.pill:not([data-state="thinking"]):not([data-state="working"]) .spin { display: none; }
.pill:not([data-state="thinking"]):not([data-state="working"]):not([data-state="needs"]) .stop { display: none; }
.pill.hold-layout:not([data-state="thinking"]):not([data-state="working"]) .spin { display: block; visibility: hidden; }
.pill.hold-layout:not([data-state="thinking"]):not([data-state="working"]):not([data-state="needs"]) .stop { display: grid; visibility: hidden; pointer-events: none; }
@keyframes ink-breathe { from { opacity: .35; } to { opacity: 1; } }
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
  .pill .spin { animation: none; }
}
:host([data-reduced-motion]) iframe, :host([data-reduced-motion]) .pill { transition: none; }
:host([data-reduced-motion]) .pill .spin { animation: none; }
`;

export const OVERLAY_STYLE = ":host { all: initial; }" + CURSOR_TOKEN_CSS + LAYER_STYLE;

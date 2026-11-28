import {
  CURSOR_INSTALL,
  CURSOR_STOP,
  CURSOR_TRANSCRIPT,
  type OrbToContent,
  type OrbVisualState,
} from "./orb-messages.js";
import {
  CURSOR_CAPTION_EVENT,
  CURSOR_COMMAND_EVENT,
  CURSOR_STATE_EVENT,
  cursorBus,
} from "@browserkit/engine/cursor-bus";
import { UNIFIED_OVERLAY_ATTR, pillDodge } from "@browserkit/engine/cursor-mark";
import type { OrbBox, OrbCursorStep } from "./orb-run.js";
import type { OrbLayout } from "./orb-messages.js";
import { OVERLAY_STYLE } from "./orb-overlay-style.js";
import {
  loadOrbPosition,
  saveOrbPosition,
  watchOrbPosition,
  type OrbPosition,
} from "./orb-position.js";

// The cursor's pill, hit target and ask box. The glyph is the shared page cursor (one shape for
// the summon and for the agent's steps). This layer remembers where it was left, drags it, and
// steps out of the way while the agent drives that same glyph. The pill says what it is doing,
// with ☰ (the transcript, in the side panel) and ■ (stop). Nothing here ever dims or blurs the page.
// Done or couldn't finish: one line, which fades after a few seconds unless hovered. A recording
// hides this layer; the engine decides whether the glyph itself stays.

const DEFAULT_PANEL = { width: 400, height: 96 };
/** Pointer summon: 400px to compose, 440px for an answer. Keyboard summon: 480px, centred. */
export const BOX_WIDTH = { compose: 400, answer: 440, keyboard: 480, teach: 340 } as const;
/** The box keeps this far inside the viewport, and opens this far from the pointer: close enough
 * that the stemless arrow and its box read as one companion. */
const EDGE = 16;
const POINTER_GAP = 6;
/** Transparent room orb.html keeps around the box (`#root` padding), so its rounded corners and
 * shadow never clip at the frame's edge. The frame is this much larger on every side. */
export const FRAME_PAD = 12;
const DRAG_SLOP = 4;
const HIT_SIZE = 32;
const RESULT_MS = 6000;

interface Point {
  x: number;
  y: number;
}

// The cursor publishes its position and presence on the isolated-world bus; the page DOM has
// no id, class or attribute for it. Cache the latest values here in the isolated world.
let cursorPoint: Point | undefined;
let cursorPresent = false;
/** Overlays whose paused loop should run again when the cursor moves or comes and goes. */
const sleepers = new Set<() => void>();
cursorBus().addEventListener(CURSOR_STATE_EVENT, (event) => {
  const detail = (event as CustomEvent<{ present?: boolean; point?: Point }>).detail;
  if (!detail) return;
  cursorPresent = detail.present !== false;
  if (detail.point && Number.isFinite(detail.point.x) && Number.isFinite(detail.point.y))
    cursorPoint = detail.point;
  for (const wake of sleepers) wake();
});

/** Nothing left to animate: the loop can pause until something changes. */
export function overlaySettled(input: {
  acting: boolean;
  dragging: boolean;
  releasePending: boolean;
  cursorPresent: boolean;
  point: Point;
  target: Point;
}): boolean {
  return (
    !input.acting &&
    !input.dragging &&
    !input.releasePending &&
    input.cursorPresent &&
    Math.abs(input.target.x - input.point.x) < 0.25 &&
    Math.abs(input.target.y - input.point.y) < 0.25
  );
}

export class OrbOverlay {
  private readonly host = document.createElement("div");
  private readonly hit = document.createElement("button");
  private readonly frame = document.createElement("iframe");
  private readonly pill = document.createElement("div");
  private readonly pillLabel = document.createElement("button");
  private label = "";
  private readonly systemReducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private reducedMotion = this.systemReducedMotion;
  private state: OrbVisualState = "listening";
  private position: OrbPosition = { left: 56, bottom: 56 };
  private point: Point;
  private target: Point;
  private panel = DEFAULT_PANEL;
  private open = false;
  /** How the box was summoned and what it shows now: decides its width and where it sits. */
  private keyboard = false;
  private layout: OrbLayout = "compose";
  /** The run points at what needs the user: the cursor waits beside it (no dim, no blur). */
  private pointing = false;
  private acting = false;
  private hovered = false;
  private fadeTimer = 0;
  private drag: { start: Point; moved: boolean } | undefined;
  private readonly timers = new Set<number>();
  private readonly stopWatching: () => void;
  private raf = 0;
  /** Frame cap: the cursor eases over hundreds of ms, so 30 fps is already more than enough. */
  private frameLast = 0;
  private readonly frameGap = 1000 / 30;
  /** Cached once per label change; reading offsetWidth every frame forces a synchronous layout. */
  private pillWidth = 0;
  private frameW = -1;
  private frameH = -1;
  /** False until the saved position loads, so a new page never shows the cursor sliding in. */
  private placed = false;
  private summonKey = "";
  private arming = false;
  private releasePending = false;

  constructor(
    readonly tabId: number,
    nonce: string,
  ) {
    this.buildDom(nonce);
    this.point = this.target = this.home();
    void loadOrbPosition().then((position) => {
      this.position = position;
      this.point = { ...this.home() };
      this.target = this.home();
      this.placed = true;
      this.wake();
    });
    sleepers.add(this.wake);
    this.stopWatching = watchOrbPosition((position) => this.moveHome(position));
    cursorBus().addEventListener(CURSOR_CAPTION_EVENT, this.onCaption);
    addEventListener("resize", this.resize);
    addEventListener("pointerdown", this.clickAway, { capture: true });
    document.addEventListener("visibilitychange", this.onVisibility);
    this.onVisibility();
  }

  /** The layer's host, so point-and-command can look past it. */
  get element(): HTMLElement {
    return this.host;
  }

  get bubbleOpen(): boolean {
    return this.open;
  }

  /** Keeps the cursor on screen after the box closes while a run is still going. */
  get running(): boolean {
    return ["thinking", "working", "needs", "paused"].includes(this.state);
  }

  showBubble(focus = true, keyboard?: boolean): void {
    if (keyboard !== undefined) this.keyboard = keyboard;
    this.open = true;
    this.updatePill();
    this.frame.classList.remove("off");
    requestAnimationFrame(() => this.frame.classList.add("on"));
    if (focus) {
      // Twice: now, and once the frame is painted, so typing lands in the field, not the page.
      this.frame.focus();
      requestAnimationFrame(() => {
        if (this.open) this.frame.focus();
      });
    }
    this.wake();
  }

  hideBubble(): void {
    this.open = false;
    this.updatePill();
    this.frame.classList.remove("on");
    this.later(() => {
      if (!this.open) this.frame.classList.add("off");
    }, 450);
    this.wake();
  }

  apply(message: OrbToContent): void {
    this.wake();
    if (message.kind === "graft.orb.visual") this.setVisual(message.state, message.label);
    else if (message.kind === "graft.orb.cursor") this.streamTo(message.steps);
    else if (message.kind === "graft.orb.spotlight") this.spotlight(message.box);
    else if (message.kind === "graft.orb.panel") {
      this.layout = message.layout ?? "compose";
      this.panel = {
        width: boxWidth(this.layout, this.keyboard),
        // The reported height includes the frame's padding; the panel is the box itself.
        height: clampSize(message.height - FRAME_PAD * 2, 32, innerHeight - EDGE * 2),
      };
    } else if (message.kind === "graft.orb.prefs") this.setReducedMotion(message.reduceMotion);
  }

  /** A recording hides the pill and the box. The shared glyph follows the engine's own rule. */
  setRecording(on: boolean): void {
    this.host.style.display = on ? "none" : "";
    if (!on) this.ensureCursor();
    this.wake();
  }

  private updatePill(): void {
    // One working pill: it stays up while the agent drives the page (the painter hands it its
    // caption), so nothing vanishes between asking and working.
    const show = !this.open && this.state !== "listening" && this.label !== "";
    if (!show) this.releasePillLayout();
    this.pill.hidden = !show;
    this.pill.dataset.state = this.state;
    this.pillLabel.textContent = this.label;
    this.pillLabel.title = this.label;
    // One layout read when the label changes, instead of one on every animation frame.
    this.pillWidth = this.pill.hidden ? 0 : this.pill.offsetWidth;
  }

  private holdPillLayout(): void {
    const width = this.pillLabel.offsetWidth;
    if (width > 0) this.pillLabel.style.minWidth = `${width}px`;
    this.pill.classList.add("hold-layout");
  }

  private releasePillLayout(): void {
    this.pillLabel.style.minWidth = "";
    this.pill.classList.remove("hold-layout");
  }

  /** The setting in Graft adds to the system's reduce-motion; it never turns that off. */
  private setReducedMotion(on: boolean): void {
    this.reducedMotion = on || this.systemReducedMotion;
    this.host.toggleAttribute("data-reduced-motion", this.reducedMotion);
  }

  destroy(): void {
    sleepers.delete(this.wake);
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const timer of this.timers) clearTimeout(timer);
    clearTimeout(this.fadeTimer);
    removeEventListener("resize", this.resize);
    removeEventListener("pointerdown", this.clickAway, { capture: true });
    cursorBus().removeEventListener(CURSOR_CAPTION_EVENT, this.onCaption);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.stopWatching();
    this.host.remove();
    if (!cursorPresent) return;
    if (this.acting)
      cursorBus().dispatchEvent(
        new CustomEvent(CURSOR_COMMAND_EVENT, { detail: { x: 0, y: 0, release: true } }),
      );
    else cursorPresent = false;
  }

  private buildDom(nonce: string): void {
    const shadow = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = OVERLAY_STYLE;
    const layer = document.createElement("div");
    layer.className = "layer";
    this.hit.className = "hit";
    this.hit.type = "button";
    this.hit.title = "Graft · click to ask, drag to move";
    this.hit.setAttribute("aria-label", "Graft");
    this.hit.addEventListener("pointerdown", this.dragStart);
    const url = new URL(chrome.runtime.getURL("orb.html"));
    url.searchParams.set("tabId", String(this.tabId));
    url.hash = nonce;
    this.frame.src = url.href;
    this.frame.title = "Graft";
    this.frame.className = "off";
    this.frame.setAttribute("allowtransparency", "true");
    this.buildPill();
    layer.append(this.hit, this.pill, this.frame);
    shadow.append(style, layer);
    // An extension reload leaves the old script's cursor on the page with nothing driving it.
    for (const stale of document.querySelectorAll("[data-ux-orb]")) stale.remove();
    this.host.setAttribute("data-ux-orb", "");
    // The engine leaves every data-ux-overlay subtree out of the page state the agent reads.
    this.host.setAttribute("data-ux-overlay", "");
    // The one overlay: the page painter finds it here and never mounts a second pill beside it.
    this.host.setAttribute(UNIFIED_OVERLAY_ATTR, "true");
    this.host.setAttribute("aria-hidden", "true");
    document.documentElement.append(this.host);
  }

  /** The pill: what it is doing (click to ask again), ☰ the transcript, ■ stop. */
  private buildPill(): void {
    this.pill.className = "pill";
    this.pill.hidden = true;
    const spin = document.createElement("span");
    spin.className = "spin";
    this.pillLabel.className = "label";
    this.pillLabel.type = "button";
    this.pillLabel.addEventListener("click", () => this.showBubble(true, false));
    const transcript = iconButton("☰", "Open the transcript in the side panel", () =>
      send(CURSOR_TRANSCRIPT),
    );
    const stop = iconButton("■", "Stop", () => send(CURSOR_STOP));
    stop.classList.add("stop");
    this.pill.append(spin, this.pillLabel, transcript, stop);
    this.pill.addEventListener("mouseenter", () => {
      this.hovered = true;
      this.pill.classList.remove("fading");
    });
    this.pill.addEventListener("mouseleave", () => {
      this.hovered = false;
      this.releasePillLayout();
      this.pillWidth = this.pill.hidden ? 0 : this.pill.offsetWidth;
      this.scheduleFade();
    });
  }

  private syncPillLayoutHold(next: OrbVisualState): void {
    const settled = next === "done" || next === "error";
    const wasRunning = this.state === "thinking" || this.state === "working";
    if (this.hovered && !this.pill.hidden && wasRunning && settled) this.holdPillLayout();
    else if (next === "thinking" || next === "working") this.releasePillLayout();
  }

  private setVisual(state: OrbVisualState, label: string): void {
    this.syncPillLayoutHold(state);
    this.state = state;
    this.label = state === "listening" ? "" : label;
    if (state !== "working") this.showCursor();
    if (state !== "needs") this.spotlight(null);
    this.updatePill();
    this.pill.classList.remove("fading");
    clearTimeout(this.fadeTimer);
    this.scheduleFade();
    // A question comes to the user even if they closed the box: its field opens, focus stays put.
    if (state === "needs" && !this.open) this.showBubble(false);
  }

  /** A result or a failure is one line that goes after a few seconds, unless hovered. */
  private scheduleFade(): void {
    if (this.state !== "done" && this.state !== "error") return;
    clearTimeout(this.fadeTimer);
    this.fadeTimer = window.setTimeout(() => {
      if (!this.hovered && !this.open) this.pill.classList.add("fading");
    }, RESULT_MS);
  }

  /** The agent acts in this page: stop writing the summon so the engine drives the same glyph. */
  private streamTo(steps: readonly OrbCursorStep[]): void {
    if (!steps[0] || this.acting) return;
    this.acting = true;
    this.hit.hidden = true;
    this.updatePill();
  }

  private showCursor(): void {
    this.hit.hidden = false;
    if (this.state === "needs") {
      this.acting = false;
      return;
    }
    this.releasePending = this.acting;
    this.acting = false;
    if (!this.pointing) this.target = this.home();
  }

  /** The cursor waits beside what needs the user. The page itself is never dimmed or blurred. */
  private spotlight(box: OrbBox | null): void {
    if (!box) {
      this.pointing = false;
      this.target = this.home();
      return;
    }
    this.pointing = true;
    this.showCursor();
    // The cursor waits beside what needs the user.
    this.target = this.clampPoint({ x: box.x - 26, y: box.y + box.height / 2 });
  }

  private home(): Point {
    return this.clampPoint({ x: this.position.left, y: innerHeight - this.position.bottom });
  }

  private moveHome(position: OrbPosition): void {
    this.position = position;
    if (!this.pointing && !this.acting) this.target = this.home();
    this.wake();
  }

  private readonly dragStart = (event: PointerEvent): void => {
    if (event.button !== 0 || this.acting) return;
    event.preventDefault();
    this.hit.setPointerCapture(event.pointerId);
    this.drag = { start: { x: event.clientX, y: event.clientY }, moved: false };
    this.hit.addEventListener("pointermove", this.dragMove);
    this.hit.addEventListener("pointerup", this.dragEnd, { once: true });
    this.wake();
  };

  private readonly dragMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    const far = Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y);
    if (far > DRAG_SLOP) drag.moved = true;
    if (!drag.moved) return;
    this.target = this.point = this.clampPoint({ x: event.clientX, y: event.clientY });
    this.wake();
  };

  private readonly dragEnd = (): void => {
    this.hit.removeEventListener("pointermove", this.dragMove);
    const moved = this.drag?.moved === true;
    this.drag = undefined;
    this.wake();
    if (!moved) {
      if (this.open) this.hideBubble();
      // A click on the cursor is a pointer summon: open beside it, even after a keyboard one.
      else this.showBubble(true, false);
      return;
    }
    this.position = {
      left: Math.round(this.point.x),
      bottom: Math.round(innerHeight - this.point.y),
    };
    void saveOrbPosition(this.position);
  };

  /** A click anywhere on the page (not in the box or on the cursor) collapses the box. */
  private readonly clickAway = (event: PointerEvent): void => {
    if (!this.open || this.layout === "teach" || event.composedPath().includes(this.host)) return;
    this.hideBubble();
  };

  /** A hidden tab does no cursor work at all; visibilitychange restarts the loop. */
  private readonly onVisibility = (): void => {
    if (document.hidden) {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    } else {
      this.frameLast = 0;
      this.wake();
    }
  };

  /** Runs the loop again after it paused on a settled cursor; a no-op while it is running. */
  private readonly wake = (): void => {
    if (this.raf || document.hidden) return;
    this.raf = requestAnimationFrame(this.tick);
  };

  private readonly tick = (time: number): void => {
    this.raf = 0;
    if (document.hidden) return;
    if (time - this.frameLast >= this.frameGap - 4) {
      this.frameLast = time;
      if (!this.acting) this.ensureCursor();
      const ease = this.reducedMotion ? 1 : 0.16;
      this.point.x += (this.target.x - this.point.x) * ease;
      this.point.y += (this.target.y - this.point.y) * ease;
      if (!this.acting && this.state !== "needs")
        this.writeSummon(this.drag?.moved === true, this.releasePending);
      this.releasePending = false;
      this.placeChrome(this.glyphPoint());
      if (this.settled()) return;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private settled(): boolean {
    return overlaySettled({
      acting: this.acting,
      dragging: this.drag !== undefined,
      releasePending: this.releasePending,
      cursorPresent,
      point: this.point,
      target: this.target,
    });
  }

  /** Beside the pointer, keyboard-centred, or Teach's bottom-centre pill: see `framePlace`. */
  private placeFrame(at: Point): void {
    if (!this.open) return; // the closed box is visibility:hidden; don't lay it out every frame
    // Width follows the current summon (a pointer summon after a keyboard one is narrower again).
    const width = boxWidth(this.layout, this.keyboard);
    const { height } = this.panel;
    const place = framePlace({
      at,
      width,
      height,
      viewport: { width: innerWidth, height: innerHeight },
      mode: this.layout === "teach" ? "teach" : this.keyboard ? "keyboard" : "pointer",
    });
    const frameW = width + FRAME_PAD * 2;
    const frameH = height + FRAME_PAD * 2;
    if (frameW !== this.frameW) {
      this.frame.style.width = frameW + "px";
      this.frameW = frameW;
    }
    if (frameH !== this.frameH) {
      this.frame.style.height = frameH + "px";
      this.frameH = frameH;
    }
    this.frame.style.left = place.left - FRAME_PAD + "px";
    this.frame.style.top = place.top - FRAME_PAD + "px";
    this.frame.style.transformOrigin = place.origin;
  }

  private placeChrome(at: Point): void {
    const { x, y } = at;
    this.hit.style.visibility = this.placed ? "" : "hidden";
    this.hit.style.transform = `translate(${x - HIT_SIZE / 2}px, ${y - HIT_SIZE / 2}px)`;
    this.placePill(x, y);
    this.placeFrame(at);
  }

  private placePill(x: number, y: number): void {
    if (this.pill.hidden) return;
    const width = this.pillWidth;
    // While the agent drives, the pill waits at home instead of riding on the cursor, and steps
    // to the far corner when the cursor heads within reach of it.
    const anchor = this.acting ? this.home() : { x, y };
    const left = anchor.x + 24 + width > innerWidth - 8 ? anchor.x - 8 - width : anchor.x + 24;
    const top = anchor.y + 16;
    const place = this.acting
      ? dockedPill({ x: left, y: top, w: width, h: 34 }, cursorPoint)
      : null;
    this.pill.style.transform = `translate(${place?.x ?? left}px, ${place?.y ?? top}px)`;
  }

  private readonly onCaption = (event: Event): void => {
    const text = (event as CustomEvent<{ text?: unknown }>).detail?.text;
    if (typeof text !== "string" || !text || !this.running) return;
    this.label = text;
    this.updatePill();
    this.wake();
  };

  private glyphPoint(): Point {
    return cursorPoint ?? this.point;
  }

  private writeSummon(place: boolean, release: boolean): void {
    if (!cursorPresent) return;
    const x = Math.round(this.target.x);
    const y = Math.round(this.target.y);
    const key = JSON.stringify({ x, y, place, release: false });
    if (key === this.summonKey && !release) return;
    this.summonKey = key;
    cursorBus().dispatchEvent(
      new CustomEvent(CURSOR_COMMAND_EVENT, { detail: { x, y, place, release } }),
    );
  }

  private ensureCursor(): void {
    if (this.arming || this.acting || !chrome.runtime?.id) return;
    if (cursorPresent) return;
    this.arming = true;
    const home = this.home();
    void chrome.runtime
      .sendMessage({ kind: CURSOR_INSTALL, x: Math.round(home.x), y: Math.round(home.y) })
      .catch(() => undefined)
      .finally(() => {
        this.later(() => {
          this.arming = false;
        }, 400);
      });
  }

  private clampPoint(point: Point): Point {
    return {
      x: clampSize(point.x, 12, innerWidth - 24),
      y: clampSize(point.y, 12, innerHeight - 40),
    };
  }

  private readonly resize = (): void => {
    this.target = this.pointing ? this.clampPoint(this.target) : this.home();
    this.wake();
  };

  private later(run: () => void, ms: number): void {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    this.timers.add(timer);
  }
}

function iconButton(text: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "ic";
  button.type = "button";
  button.textContent = text;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

/** Runs in the click itself, so the side panel opens with the user's gesture. */
function send(kind: string): void {
  if (chrome.runtime?.id) void chrome.runtime.sendMessage({ kind }).catch(() => undefined);
}

export function boxWidth(layout: OrbLayout, keyboard: boolean): number {
  if (layout === "teach") return BOX_WIDTH.teach;
  if (keyboard) return BOX_WIDTH.keyboard;
  return layout === "answer" ? BOX_WIDTH.answer : BOX_WIDTH.compose;
}

/**
 * Where the box sits. Pointer: 6px beside the pointer, flipped left or up when it would overflow.
 * Keyboard: centred horizontally in the upper third (top at 22vh), no pointer offset. Teach: a
 * pill at the bottom centre, clear of the page's middle. Always whole, 16px inside the viewport.
 */
export function framePlace(input: {
  at: Point;
  width: number;
  height: number;
  viewport: { width: number; height: number };
  mode: "pointer" | "keyboard" | "teach";
}): { left: number; top: number; origin: string } {
  const { at, width, height, viewport, mode } = input;
  const maxLeft = Math.max(EDGE, viewport.width - width - EDGE);
  const maxTop = Math.max(EDGE, viewport.height - height - EDGE);
  if (mode === "keyboard")
    return {
      left: clampSize((viewport.width - width) / 2, EDGE, maxLeft),
      top: clampSize(Math.round(viewport.height * 0.22), EDGE, maxTop),
      origin: "50% 0",
    };
  if (mode === "teach")
    return {
      left: clampSize((viewport.width - width) / 2, EDGE, maxLeft),
      top: clampSize(viewport.height - height - 24, EDGE, maxTop),
      origin: "50% 100%",
    };
  const right = at.x + POINTER_GAP + width <= viewport.width - EDGE;
  const below = at.y + POINTER_GAP + height <= viewport.height - EDGE;
  const left = right ? at.x + POINTER_GAP : at.x - POINTER_GAP - width;
  const top = below ? at.y + POINTER_GAP : at.y - POINTER_GAP - height;
  return {
    left: clampSize(left, EDGE, maxLeft),
    top: clampSize(top, EDGE, maxTop),
    origin: `${right ? "0" : "100%"} ${below ? "0" : "100%"}`,
  };
}

function clampSize(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Where the working pill moves when `target` comes within 48px of it; null when it is clear. */
export function dockedPill(
  pill: { x: number; y: number; w: number; h: number },
  target: Point | undefined,
  view: { w: number; h: number } = { w: innerWidth, h: innerHeight },
): Point | null {
  if (!target) return null;
  const corner = pillDodge(pill, target, view);
  if (!corner) return null;
  return {
    x: corner.endsWith("left") ? 16 : view.w - 16 - pill.w,
    y: corner.startsWith("top") ? 16 : view.h - 16 - pill.h,
  };
}

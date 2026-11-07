import {
  CURSOR_STOP,
  CURSOR_TRANSCRIPT,
  type OrbToContent,
  type OrbVisualState,
} from "./orb-messages.js";
import type { OrbBox, OrbCursorStep } from "./orb-run.js";
import { CURSOR_PATH, OVERLAY_STYLE, spotlightGradient } from "./orb-overlay-style.js";
import {
  loadOrbPosition,
  saveOrbPosition,
  watchOrbPosition,
  type OrbPosition,
} from "./orb-position.js";

// Everything the cursor draws over the page. The cursor is one thing: a white pointer that sits
// where it was left (bottom-left by default, dragged anywhere, one position for every site) with
// its pill beside it. Summoned, the pill opens as the ask box (orb.html, framed so the page can't
// read it). Working, the pill says what it is doing, with ☰ (the transcript, in the side panel)
// and ■ (stop); when the agent acts in this page, the engine's identical cursor takes over and this
// one steps aside. It needs you: the pill turns amber. Done or couldn't finish: one line, which
// fades after a few seconds unless hovered. While the tab is recorded on video nothing is drawn.

const DEFAULT_PANEL = { width: 360, height: 96 };
const TRAVEL_MS = 650;
const DRAG_SLOP = 4;
const HIT_SIZE = 32;
const RESULT_MS = 6000;

interface Point {
  x: number;
  y: number;
}

export class OrbOverlay {
  private readonly host = document.createElement("div");
  private readonly cursor = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  private readonly spot = document.createElement("div");
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
  private acting = false;
  private hovered = false;
  private fadeTimer = 0;
  private drag: { start: Point; moved: boolean } | undefined;
  private readonly timers = new Set<number>();
  private readonly stopWatching: () => void;
  private raf = 0;
  /** False until the saved position loads, so a new page never shows the cursor sliding in. */
  private placed = false;

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
    });
    this.stopWatching = watchOrbPosition((position) => this.moveHome(position));
    addEventListener("resize", this.resize);
    addEventListener("pointerdown", this.clickAway, { capture: true });
    this.raf = requestAnimationFrame(this.tick);
  }

  get bubbleOpen(): boolean {
    return this.open;
  }

  /** Keeps the cursor on screen after the box closes while a run is still going. */
  get running(): boolean {
    return ["thinking", "working", "needs", "paused"].includes(this.state);
  }

  showBubble(focus = true): void {
    this.open = true;
    this.updatePill();
    this.frame.classList.remove("off");
    requestAnimationFrame(() => this.frame.classList.add("on"));
    if (focus) this.frame.focus();
  }

  hideBubble(): void {
    this.open = false;
    this.updatePill();
    this.frame.classList.remove("on");
    this.later(() => {
      if (!this.open) this.frame.classList.add("off");
    }, 450);
  }

  apply(message: OrbToContent): void {
    if (message.kind === "aeon.orb.visual") this.setVisual(message.state, message.label);
    else if (message.kind === "aeon.orb.cursor") this.streamTo(message.steps);
    else if (message.kind === "aeon.orb.spotlight") this.spotlight(message.box);
    else if (message.kind === "aeon.orb.panel")
      this.panel = {
        width: clampSize(message.width, 260, 440),
        height: clampSize(message.height, 44, innerHeight - 16),
      };
    else if (message.kind === "aeon.orb.prefs") this.setReducedMotion(message.reduceMotion);
  }

  /** A video recording of this tab shows the page only. */
  setRecording(on: boolean): void {
    this.host.style.display = on ? "none" : "";
  }

  private updatePill(): void {
    const show = !this.open && this.state !== "listening" && this.label !== "" && !this.acting;
    this.pill.hidden = !show;
    this.pill.dataset.state = this.state;
    this.pillLabel.textContent = this.label;
    this.pillLabel.title = this.label;
  }

  /** The setting in Aeon adds to the system's reduce-motion; it never turns that off. */
  private setReducedMotion(on: boolean): void {
    this.reducedMotion = on || this.systemReducedMotion;
    this.host.toggleAttribute("data-reduced-motion", this.reducedMotion);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    for (const timer of this.timers) clearTimeout(timer);
    clearTimeout(this.fadeTimer);
    removeEventListener("resize", this.resize);
    removeEventListener("pointerdown", this.clickAway, { capture: true });
    this.stopWatching();
    this.host.remove();
  }

  private buildDom(nonce: string): void {
    const shadow = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = OVERLAY_STYLE;
    const layer = document.createElement("div");
    layer.className = "layer";
    this.spot.className = "spot";
    this.buildCursor();
    this.hit.className = "hit";
    this.hit.type = "button";
    this.hit.title = "Aeon · click to ask, drag to move";
    this.hit.setAttribute("aria-label", "Aeon");
    this.hit.addEventListener("pointerdown", this.dragStart);
    const url = new URL(chrome.runtime.getURL("orb.html"));
    url.searchParams.set("tabId", String(this.tabId));
    url.hash = nonce;
    this.frame.src = url.href;
    this.frame.title = "Aeon";
    this.frame.className = "off";
    this.frame.setAttribute("allowtransparency", "true");
    this.buildPill();
    layer.append(this.spot, this.cursor, this.hit, this.pill, this.frame);
    shadow.append(style, layer);
    // An extension reload leaves the old script's cursor on the page with nothing driving it.
    for (const stale of document.querySelectorAll("[data-aeon-orb]")) stale.remove();
    this.host.setAttribute("data-aeon-orb", "");
    document.documentElement.append(this.host);
  }

  private buildCursor(): void {
    this.cursor.setAttribute("class", "cursor");
    this.cursor.setAttribute("viewBox", "0 0 18 20");
    this.cursor.setAttribute("width", "18");
    this.cursor.setAttribute("height", "20");
    this.cursor.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", CURSOR_PATH);
    path.setAttribute("fill", "#fff");
    path.setAttribute("stroke", "#111");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linejoin", "round");
    this.cursor.append(path);
  }

  /** The pill: what it is doing (click to ask again), ☰ the transcript, ■ stop. */
  private buildPill(): void {
    this.pill.className = "pill";
    this.pill.hidden = true;
    const spin = document.createElement("span");
    spin.className = "spin";
    this.pillLabel.className = "label";
    this.pillLabel.type = "button";
    this.pillLabel.addEventListener("click", () => this.showBubble());
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
      this.scheduleFade();
    });
  }

  private setVisual(state: OrbVisualState, label: string): void {
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

  /** The agent acts in this page: the engine's cursor takes over from here, this one steps aside. */
  private streamTo(steps: readonly OrbCursorStep[]): void {
    const first = steps[0];
    if (!first || this.acting) return;
    this.target = this.clampPoint({ x: first.x, y: first.y });
    this.later(() => {
      if (this.state !== "working") return;
      this.acting = true;
      this.cursor.classList.add("away");
      this.updatePill();
    }, TRAVEL_MS);
  }

  private showCursor(): void {
    this.acting = false;
    this.cursor.classList.remove("away");
    if (!this.spot.classList.contains("on")) this.target = this.home();
  }

  private spotlight(box: OrbBox | null): void {
    if (!box) {
      this.spot.classList.remove("on");
      this.target = this.home();
      return;
    }
    this.spot.style.background = spotlightGradient(box);
    this.spot.classList.add("on");
    this.showCursor();
    // The cursor waits beside what needs the user.
    this.target = this.clampPoint({ x: box.x - 26, y: box.y + box.height / 2 });
  }

  private home(): Point {
    return this.clampPoint({ x: this.position.left, y: innerHeight - this.position.bottom });
  }

  private moveHome(position: OrbPosition): void {
    this.position = position;
    if (!this.spot.classList.contains("on") && !this.acting) this.target = this.home();
  }

  private readonly dragStart = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    this.hit.setPointerCapture(event.pointerId);
    this.drag = { start: { x: event.clientX, y: event.clientY }, moved: false };
    this.hit.addEventListener("pointermove", this.dragMove);
    this.hit.addEventListener("pointerup", this.dragEnd, { once: true });
  };

  private readonly dragMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    const far = Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y);
    if (far > DRAG_SLOP) drag.moved = true;
    if (!drag.moved) return;
    this.target = this.point = this.clampPoint({ x: event.clientX, y: event.clientY });
  };

  private readonly dragEnd = (): void => {
    this.hit.removeEventListener("pointermove", this.dragMove);
    const moved = this.drag?.moved === true;
    this.drag = undefined;
    if (!moved) {
      if (this.open) this.hideBubble();
      else this.showBubble();
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
    if (!this.open || event.composedPath().includes(this.host)) return;
    this.hideBubble();
  };

  private readonly tick = (): void => {
    const ease = this.reducedMotion ? 1 : 0.16;
    this.point.x += (this.target.x - this.point.x) * ease;
    this.point.y += (this.target.y - this.point.y) * ease;
    const { x, y } = this.point;
    // The point is the cursor's tip; the hit area sits around it, the pill beside it.
    this.cursor.style.transform = `translate(${x - 1}px, ${y - 1}px)`;
    this.cursor.style.visibility = this.placed ? "" : "hidden";
    this.hit.style.transform = `translate(${x - HIT_SIZE / 2 + 6}px, ${y - HIT_SIZE / 2 + 8}px)`;
    if (!this.pill.hidden) {
      const width = this.pill.offsetWidth;
      const left = x + 18 + width > innerWidth - 8 ? x - 8 - width : x + 18;
      this.pill.style.transform = `translate(${left}px, ${y + 14}px)`;
    }
    this.placeFrame();
    this.raf = requestAnimationFrame(this.tick);
  };

  /** The box opens beside the cursor's tip, where the pill would be, on the side with room. */
  private placeFrame(): void {
    const { width, height } = this.panel;
    let left = this.point.x + 18;
    if (left + width > innerWidth - 8) left = this.point.x - 8 - width;
    const top = clampSize(this.point.y + 14, 8, innerHeight - height - 8);
    this.frame.style.width = width + "px";
    this.frame.style.height = height + "px";
    this.frame.style.left = clampSize(left, 8, innerWidth - width - 8) + "px";
    this.frame.style.top = top + "px";
    this.frame.style.transformOrigin = left > this.point.x ? "0 0" : "100% 0";
  }

  private clampPoint(point: Point): Point {
    return {
      x: clampSize(point.x, 12, innerWidth - 24),
      y: clampSize(point.y, 12, innerHeight - 40),
    };
  }

  private readonly resize = (): void => {
    this.target = this.spot.classList.contains("on") ? this.clampPoint(this.target) : this.home();
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

function clampSize(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

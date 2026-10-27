import type { OrbToContent, OrbVisualState } from "./orb-messages.js";
import type { OrbBox, OrbCursorStep } from "./orb-run.js";
import { OVERLAY_STYLE, spotlightGradient } from "./orb-overlay-style.js";
import { Swarm } from "./orb-swarm.js";
import {
  loadOrbPosition,
  saveOrbPosition,
  watchOrbPosition,
  type OrbPosition,
} from "./orb-position.js";

// Everything the orb draws over the page. The swarm is the orb: it is there whenever the orb is
// summoned, streams into the engine's cursor when the agent acts and fades out while it does, and
// gathers beside anything that needs the user. The box (orb.html, framed so the page can't read
// it) opens with the orb; clicking away collapses it to the orb, clicking the orb opens it again.
// The orb sits bottom-left by default, can be dragged, and keeps one position for every site.

const DEFAULT_PANEL = { width: 360, height: 96 };
const TRAVEL_MS = 650;
const DRAG_SLOP = 4;
const HIT_SIZE = 64;

interface Point {
  x: number;
  y: number;
}

export class OrbOverlay {
  private readonly host = document.createElement("div");
  private readonly canvas = document.createElement("canvas");
  private readonly spot = document.createElement("div");
  private readonly hit = document.createElement("button");
  private readonly frame = document.createElement("iframe");
  private readonly swarm: Swarm;
  private readonly systemReducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private reducedMotion = this.systemReducedMotion;
  private state: OrbVisualState = "listening";
  private position: OrbPosition = { left: 56, bottom: 56 };
  private orb: Point;
  private orbTarget: Point;
  private panel = DEFAULT_PANEL;
  private open = false;
  private acting = false;
  private drag: { start: Point; moved: boolean } | undefined;
  private readonly timers = new Set<number>();
  private readonly stopWatching: () => void;
  private raf = 0;

  constructor(
    readonly tabId: number,
    nonce: string,
  ) {
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    this.swarm = new Swarm(context, this.reducedMotion);
    this.buildDom(nonce);
    this.orb = this.orbTarget = this.home();
    this.swarm.setCenter(this.orb.x, this.orb.y);
    void loadOrbPosition().then((position) => this.moveHome(position));
    this.stopWatching = watchOrbPosition((position) => this.moveHome(position));
    addEventListener("resize", this.resize);
    addEventListener("pointerdown", this.clickAway, { capture: true });
    this.resize();
    this.raf = requestAnimationFrame(this.tick);
  }

  get bubbleOpen(): boolean {
    return this.open;
  }

  /** Keeps the orb on screen after the box closes while a run is still going. */
  get running(): boolean {
    return ["thinking", "working", "needs", "paused"].includes(this.state);
  }

  showBubble(focus = true): void {
    this.open = true;
    this.frame.classList.remove("off");
    requestAnimationFrame(() => this.frame.classList.add("on"));
    if (focus) this.frame.focus();
  }

  hideBubble(): void {
    this.open = false;
    this.frame.classList.remove("on");
    this.later(() => {
      if (!this.open) this.frame.classList.add("off");
    }, 450);
  }

  apply(message: OrbToContent): void {
    if (message.kind === "aeon.orb.visual") this.setVisual(message.state);
    else if (message.kind === "aeon.orb.cursor") this.streamTo(message.steps);
    else if (message.kind === "aeon.orb.spotlight") this.spotlight(message.box);
    else if (message.kind === "aeon.orb.panel")
      this.panel = {
        width: clampSize(message.width, 260, 440),
        height: clampSize(message.height, 44, innerHeight - 16),
      };
    else if (message.kind === "aeon.orb.prefs") this.setReducedMotion(message.reduceMotion);
  }

  /** The setting in Aeon adds to the system's reduce-motion; it never turns that off. */
  private setReducedMotion(on: boolean): void {
    this.reducedMotion = on || this.systemReducedMotion;
    this.swarm.reducedMotion = this.reducedMotion;
    this.host.toggleAttribute("data-reduced-motion", this.reducedMotion);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    for (const timer of this.timers) clearTimeout(timer);
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
    this.hit.className = "hit";
    this.hit.type = "button";
    this.hit.title = "Aeon · click to open, drag to move";
    this.hit.setAttribute("aria-label", "Aeon");
    this.hit.addEventListener("pointerdown", this.dragStart);
    const url = new URL(chrome.runtime.getURL("orb.html"));
    url.searchParams.set("tabId", String(this.tabId));
    url.hash = nonce;
    this.frame.src = url.href;
    this.frame.title = "Aeon";
    this.frame.className = "off";
    this.frame.setAttribute("allowtransparency", "true");
    layer.append(this.spot, this.canvas, this.hit, this.frame);
    shadow.append(style, layer);
    document.documentElement.append(this.host);
  }

  private setVisual(state: OrbVisualState): void {
    this.state = state;
    this.swarm.setState(state);
    if (state !== "working") this.showSwarm();
    if (state !== "needs") this.spotlight(null);
    // Results and questions come to the user even if they closed the box; focus stays put.
    if (!this.open && (state === "done" || state === "needs" || state === "error"))
      this.showBubble(false);
  }

  /** The agent acts: the swarm streams to where the engine's cursor is going, then fades out. */
  private streamTo(steps: readonly OrbCursorStep[]): void {
    const first = steps[0];
    if (!first || this.acting) return;
    this.acting = true;
    this.swarm.setCursor(first);
    this.later(() => {
      if (this.state === "working") this.canvas.classList.add("away");
    }, TRAVEL_MS);
  }

  private showSwarm(): void {
    this.acting = false;
    this.swarm.setCursor(null);
    this.canvas.classList.remove("away");
  }

  private spotlight(box: OrbBox | null): void {
    if (!box) {
      this.spot.classList.remove("on");
      this.orbTarget = this.home();
      return;
    }
    this.spot.style.background = spotlightGradient(box);
    this.spot.classList.add("on");
    this.showSwarm();
    // The swarm waits beside what needs the user.
    this.orbTarget = this.clampOrb({ x: box.x - 34, y: box.y + box.height / 2 });
  }

  private home(): Point {
    return this.clampOrb({ x: this.position.left, y: innerHeight - this.position.bottom });
  }

  private moveHome(position: OrbPosition): void {
    this.position = position;
    if (!this.spot.classList.contains("on")) this.orbTarget = this.home();
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
    this.orbTarget = this.orb = this.clampOrb({ x: event.clientX, y: event.clientY });
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
    this.position = { left: Math.round(this.orb.x), bottom: Math.round(innerHeight - this.orb.y) };
    void saveOrbPosition(this.position);
  };

  /** A click anywhere on the page (not in the box or on the orb) collapses the box. */
  private readonly clickAway = (event: PointerEvent): void => {
    if (!this.open || event.composedPath().includes(this.host)) return;
    this.hideBubble();
  };

  private readonly tick = (now: number): void => {
    this.orb.x += (this.orbTarget.x - this.orb.x) * 0.12;
    this.orb.y += (this.orbTarget.y - this.orb.y) * 0.12;
    this.swarm.setCenter(this.orb.x, this.orb.y);
    this.hit.style.transform = `translate(${this.orb.x - HIT_SIZE / 2}px, ${this.orb.y - HIT_SIZE / 2}px)`;
    this.placeFrame();
    this.swarm.draw(now, innerWidth, innerHeight);
    this.raf = requestAnimationFrame(this.tick);
  };

  /** The box sits beside the orb on the side with room, its bottom level with the orb. */
  private placeFrame(): void {
    const { width, height } = this.panel;
    let left = this.orb.x + 34;
    if (left + width > innerWidth - 8) left = this.orb.x - 34 - width;
    const top = clampSize(this.orb.y + 26 - height, 8, innerHeight - height - 8);
    this.frame.style.width = width + "px";
    this.frame.style.height = height + "px";
    this.frame.style.left = clampSize(left, 8, innerWidth - width - 8) + "px";
    this.frame.style.top = top + "px";
    this.frame.style.transformOrigin = left > this.orb.x ? "0 100%" : "100% 100%";
  }

  private clampOrb(point: Point): Point {
    return {
      x: clampSize(point.x, 34, innerWidth - 34),
      y: clampSize(point.y, 34, innerHeight - 34),
    };
  }

  private readonly resize = (): void => {
    const ratio = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = Math.round(innerWidth * ratio);
    this.canvas.height = Math.round(innerHeight * ratio);
    this.canvas.style.width = innerWidth + "px";
    this.canvas.style.height = innerHeight + "px";
    this.canvas.getContext("2d")?.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.orbTarget = this.spot.classList.contains("on")
      ? this.clampOrb(this.orbTarget)
      : this.home();
  };

  private later(run: () => void, ms: number): void {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    this.timers.add(timer);
  }
}

function clampSize(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

import type { OrbToContent, OrbVisualState } from "./orb-messages.js";
import type { OrbBox, OrbCursorStep } from "./orb-run.js";
import { CURSOR_SVG, OVERLAY_STYLE, spotlightGradient } from "./orb-overlay-style.js";
import { Swarm } from "./orb-swarm.js";

// Everything the orb draws over the page. All of it is pointer-transparent except the bubble,
// which is orb.html in an iframe so the page can't read what the user types.

const DEFAULT_PANEL = { width: 360, height: 96 };
const ACTING_KINDS = /click|fill|type|press|select|check|drag|upload/i;
const TRAVEL_MS = 650;

interface Point {
  x: number;
  y: number;
}

export class OrbOverlay {
  private readonly host = document.createElement("div");
  private readonly canvas = document.createElement("canvas");
  private readonly spot = document.createElement("div");
  private readonly cursor = document.createElement("div");
  private readonly label = document.createElement("div");
  private readonly ring = document.createElement("div");
  private readonly frame = document.createElement("iframe");
  private readonly edge = document.createElement("div");
  private readonly swarm: Swarm;
  private readonly systemReducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private reducedMotion = this.systemReducedMotion;
  private state: OrbVisualState = "listening";
  private orb: Point = { x: 0, y: 0 };
  private orbTarget: Point = { x: 0, y: 0 };
  private cursorAt: Point | null = null;
  private cursorTarget: Point | null = null;
  private panel = DEFAULT_PANEL;
  private open = false;
  private playUntil = 0;
  private readonly timers = new Set<number>();
  private raf = 0;

  constructor(
    readonly tabId: number,
    nonce: string,
    at: Point,
  ) {
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    this.swarm = new Swarm(context, this.reducedMotion);
    this.buildDom(nonce);
    this.orb = this.orbTarget = this.clampOrb({ x: at.x + 26, y: at.y + 26 });
    this.swarm.setCenter(this.orb.x, this.orb.y);
    addEventListener("resize", this.resize);
    this.resize();
    this.raf = requestAnimationFrame(this.tick);
  }

  get bubbleOpen(): boolean {
    return this.open;
  }

  /** Keeps the swarm on screen after the bubble closes while a run is still going. */
  get running(): boolean {
    return ["thinking", "working", "needs", "paused"].includes(this.state);
  }

  showBubble(at?: Point, focus = true): void {
    if (at && !this.running) this.orbTarget = this.clampOrb({ x: at.x + 26, y: at.y + 26 });
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
    if (message.kind === "aeon.orb.visual") this.setVisual(message.state, message.label);
    else if (message.kind === "aeon.orb.cursor") this.play(message.steps);
    else if (message.kind === "aeon.orb.spotlight") this.spotlight(message.box);
    else if (message.kind === "aeon.orb.panel")
      this.panel = {
        width: clampSize(message.width, 260, 420),
        height: clampSize(message.height, 44, 560),
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
    this.host.remove();
  }

  private buildDom(nonce: string): void {
    const shadow = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = OVERLAY_STYLE;
    const layer = document.createElement("div");
    layer.className = "layer";
    this.spot.className = "spot";
    this.edge.className = "edge";
    this.cursor.className = "cursor";
    this.cursor.innerHTML = CURSOR_SVG;
    this.label.className = "label";
    this.cursor.append(this.label);
    this.ring.className = "ring";
    const url = new URL(chrome.runtime.getURL("orb.html"));
    url.searchParams.set("tabId", String(this.tabId));
    url.hash = nonce;
    this.frame.src = url.href;
    this.frame.title = "Aeon";
    this.frame.className = "off";
    this.frame.setAttribute("allowtransparency", "true");
    layer.append(this.edge, this.spot, this.canvas, this.ring, this.cursor, this.frame);
    shadow.append(style, layer);
    document.documentElement.append(this.host);
  }

  private setVisual(state: OrbVisualState, label: string): void {
    this.state = state;
    this.swarm.setState(state);
    this.label.textContent = label;
    // While the agent drives this tab, its edges glow.
    this.edge.classList.toggle("on", state === "thinking" || state === "working");
    if (state !== "working" && Date.now() >= this.playUntil) this.releaseCursor();
    if (state !== "needs") this.spotlight(null);
    // Results and questions come to the user even if they closed the bubble; focus stays put.
    if (!this.open && (state === "done" || state === "needs" || state === "error"))
      this.showBubble(undefined, false);
  }

  /** Replays trace actions: the swarm streams into the cursor, which visits each target in turn. */
  private play(steps: readonly OrbCursorStep[]): void {
    if (!steps.length) return;
    let at = Math.max(0, this.playUntil - Date.now());
    if (!this.cursorAt) this.cursorAt = { ...this.orb };
    this.cursor.classList.add("on");
    for (const step of steps) {
      at += step.delayMs;
      this.later(() => (this.cursorTarget = { x: step.x, y: step.y }), at);
      if (ACTING_KINDS.test(step.kind)) this.later(() => this.click(step), at + TRAVEL_MS);
      at += TRAVEL_MS;
    }
    this.playUntil = Date.now() + at;
    this.later(() => {
      if (this.state !== "working") this.releaseCursor();
    }, at + 200);
  }

  private click(point: Point): void {
    this.ring.style.left = point.x + "px";
    this.ring.style.top = point.y + "px";
    this.ring.classList.remove("go");
    void this.ring.offsetWidth;
    this.ring.classList.add("go");
    this.swarm.burst(point.x, point.y, performance.now());
  }

  private releaseCursor(): void {
    this.cursor.classList.remove("on");
    this.cursorAt = this.cursorTarget = null;
    this.swarm.setCursor(null);
  }

  private spotlight(box: OrbBox | null): void {
    if (!box) {
      this.spot.classList.remove("on");
      return;
    }
    this.spot.style.background = spotlightGradient(box);
    this.spot.classList.add("on");
    // The swarm waits beside what needs the user.
    this.orbTarget = this.clampOrb({ x: box.x - 34, y: box.y + box.height / 2 });
  }

  private readonly tick = (now: number): void => {
    this.orb.x += (this.orbTarget.x - this.orb.x) * 0.12;
    this.orb.y += (this.orbTarget.y - this.orb.y) * 0.12;
    this.swarm.setCenter(this.orb.x, this.orb.y);
    this.moveCursor();
    this.placeFrame();
    this.swarm.draw(now, innerWidth, innerHeight);
    this.raf = requestAnimationFrame(this.tick);
  };

  private moveCursor(): void {
    if (!this.cursorAt || !this.cursorTarget) return;
    const rate = this.reducedMotion ? 1 : 0.09;
    this.cursorAt.x += (this.cursorTarget.x - this.cursorAt.x) * rate;
    this.cursorAt.y += (this.cursorTarget.y - this.cursorAt.y) * rate;
    this.cursor.style.transform = `translate(${this.cursorAt.x}px, ${this.cursorAt.y}px)`;
    this.swarm.setCursor(this.cursorAt);
  }

  /** The bubble sits up and to the left of the swarm, flipping when there's no room. */
  private placeFrame(): void {
    const { width, height } = this.panel;
    let left = this.orb.x - 30 - width;
    if (left < 8) left = Math.min(innerWidth - width - 8, this.orb.x + 30);
    const top = clampSize(this.orb.y + 26 - height, 8, innerHeight - height - 8);
    this.frame.style.width = width + "px";
    this.frame.style.height = height + "px";
    this.frame.style.left = Math.max(8, left) + "px";
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
    this.orbTarget = this.clampOrb(this.orbTarget);
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

import type { OrbVisualState } from "./orb-messages.js";

// The swarm: about 80 particles on a rotating sphere, drawn on a full-viewport canvas so they can
// stream across the page into the agent cursor. Numbers follow orb-candidates.html (Swarm spec).

interface Particle {
  theta: number;
  phi: number;
  speed: number;
  phase: number;
  chase: number;
  x: number;
  y: number;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  /** Travels this far (px) instead of fading in place: a step done in another tab. */
  reach?: number;
}

// One colour: Aeon's purple. Amber only when the agent needs the user; the user's own control
// and a failed run read as a quiet, dimmed swarm rather than new colours.
// [near side, far side]
const COLORS: Record<OrbVisualState, [string, string]> = {
  listening: ["#c4b5fd", "#7c5cf0"],
  working: ["#c4b5fd", "#7c5cf0"],
  thinking: ["#c4b5fd", "#7c5cf0"],
  needs: ["#ffe2a8", "#e08a00"],
  done: ["#c4b5fd", "#7c5cf0"],
  error: ["#c9c4dc", "#5b5770"],
  paused: ["#c9c4dc", "#5b5770"],
};
const ALPHA: Partial<Record<OrbVisualState, number>> = { paused: 0.55, error: 0.55, done: 0.85 };
const RADIUS: Record<OrbVisualState, number> = {
  listening: 22,
  thinking: 18,
  working: 18,
  needs: 21,
  done: 16,
  error: 17,
  paused: 15,
};
const SPEED: Record<OrbVisualState, number> = {
  listening: 0.9,
  thinking: 1.4,
  working: 1.4,
  needs: 1,
  done: 0.25,
  error: 0.3,
  paused: 0.2,
};
const SPARK_MS = 520;

export class Swarm {
  private readonly particles: Particle[];
  private readonly sparks: Spark[] = [];
  private state: OrbVisualState = "listening";
  private center = { x: 0, y: 0 };
  private groups = 1;
  private cursor: { x: number; y: number } | null = null;

  constructor(
    private readonly context: CanvasRenderingContext2D,
    public reducedMotion: boolean,
    count = 80,
  ) {
    // Spread evenly on a Fibonacci spiral and turned as one body, so the swarm reads as a lit
    // globe; each particle keeps its own chase rate for streaming into the cursor.
    this.particles = Array.from({ length: count }, (_, index) => ({
      theta: index * 2.39996,
      phi: Math.acos(1 - (index / (count - 1)) * 2),
      speed: 1,
      phase: Math.random() * Math.PI * 2,
      chase: 0.05 + Math.random() * 0.14,
      x: Number.NaN,
      y: Number.NaN,
    }));
  }

  setState(state: OrbVisualState): void {
    this.state = state;
  }

  setCenter(x: number, y: number): void {
    this.center = { x, y };
  }

  /** While set, the particles stream to the cursor tip and pack around it. */
  setCursor(point: { x: number; y: number } | null): void {
    this.cursor = point ? { x: point.x + 5, y: point.y + 7 } : null;
  }

  burst(x: number, y: number, now: number): void {
    for (let index = 0; index < 14; index += 1) {
      const angle = (index / 14) * Math.PI * 2;
      const speed = 0.06 + Math.random() * 0.05;
      this.sparks.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        born: now,
      });
    }
  }

  /** Several chats working: the swarm splits into one small swarm each (up to four). */
  setAgents(count: number): void {
    this.groups = Math.max(1, Math.min(4, Math.round(count) || 1));
  }

  /** Where particle `index` gathers: the centre, or its satellite when the swarm is split. */
  private anchorOf(index: number): { x: number; y: number; scale: number } {
    if (this.groups === 1) return { ...this.center, scale: 1 };
    const group = index % this.groups;
    const angle = -Math.PI / 2 + (group * Math.PI * 2) / this.groups;
    return {
      x: this.center.x + Math.cos(angle) * 17,
      y: this.center.y + Math.sin(angle) * 17,
      scale: 0.55,
    };
  }

  /** A step finished in another tab: a few sparks fly up toward the tab strip. */
  elsewhere(now: number): void {
    if (this.reducedMotion) return;
    for (let index = 0; index < 5; index += 1) {
      const angle = -Math.PI / 2 - 0.35 + Math.random() * 0.3;
      this.sparks.push({
        x: this.center.x + (Math.random() - 0.5) * 10,
        y: this.center.y - 12,
        vx: Math.cos(angle) * 0.42,
        vy: Math.sin(angle) * 0.42,
        born: now + index * 50,
        reach: 1,
      });
    }
  }

  draw(now: number, width: number, height: number): void {
    const context = this.context;
    context.clearRect(0, 0, width, height);
    const [light, deep] = COLORS[this.state];
    const time = now / 1000;
    const radius = this.cursor ? 7 : this.radiusAt(time);
    const speed = this.reducedMotion ? 0 : SPEED[this.state] * (this.cursor ? 1.8 : 1);
    for (const [index, particle] of this.particles.entries()) {
      const home = this.anchorOf(index);
      const anchor = this.cursor ?? home;
      particle.theta += 0.016 * speed * particle.speed;
      const r = (radius + this.wobble(time, particle.phase)) * (this.cursor ? 1 : home.scale);
      const sinPhi = Math.sin(particle.phi);
      const tx = anchor.x + r * sinPhi * Math.cos(particle.theta);
      const ty = anchor.y + r * Math.cos(particle.phi);
      const depth = (sinPhi * Math.sin(particle.theta) + 1) / 2;
      this.follow(particle, tx, ty);
      context.globalAlpha = (0.25 + 0.75 * depth) * (ALPHA[this.state] ?? 1);
      context.fillStyle = depth > 0.6 ? light : deep;
      context.beginPath();
      context.arc(particle.x, particle.y, 0.7 + depth * 1.6, 0, Math.PI * 2);
      context.fill();
    }
    this.drawSparks(now, light);
    context.globalAlpha = 1;
  }

  private radiusAt(time: number): number {
    const base = RADIUS[this.state];
    return this.state === "needs" && !this.reducedMotion ? base + 3 * Math.sin(time * 7) : base;
  }

  private wobble(time: number, phase: number): number {
    if (this.reducedMotion || this.cursor) return 0;
    if (this.state === "listening") return 2 * Math.sin(time * 8 + phase);
    return 0;
  }

  private follow(particle: Particle, tx: number, ty: number): void {
    if (Number.isNaN(particle.x) || this.reducedMotion) {
      particle.x = tx;
      particle.y = ty;
      return;
    }
    // Each particle chases at its own rate on the way to the cursor, so the swarm streams.
    const rate = this.cursor ? particle.chase : 0.18;
    particle.x += (tx - particle.x) * rate;
    particle.y += (ty - particle.y) * rate;
  }

  private drawSparks(now: number, color: string): void {
    const context = this.context;
    for (let index = this.sparks.length - 1; index >= 0; index -= 1) {
      const spark = this.sparks[index];
      if (!spark) continue;
      const age = now - spark.born;
      if (age < 0) continue;
      if (age > SPARK_MS * (spark.reach ? 2 : 1)) {
        this.sparks.splice(index, 1);
        continue;
      }
      context.globalAlpha = 1 - age / (SPARK_MS * (spark.reach ? 2 : 1));
      context.fillStyle = color;
      context.beginPath();
      context.arc(spark.x + spark.vx * age, spark.y + spark.vy * age, 1.6, 0, Math.PI * 2);
      context.fill();
    }
  }
}

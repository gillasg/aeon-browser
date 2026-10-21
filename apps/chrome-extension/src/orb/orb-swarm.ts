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
}

const COLORS: Record<OrbVisualState, [string, string]> = {
  listening: ["#9b8cff", "#4a2fd0"],
  working: ["#9b8cff", "#4a2fd0"],
  thinking: ["#8fc0ff", "#7a3cff"],
  needs: ["#ffd27a", "#ff8a00"],
  done: ["#8ff5b8", "#0fae5c"],
  error: ["#ffb3a8", "#d2412f"],
  paused: ["#c9c4dc", "#5b5770"],
};
const RADIUS: Record<OrbVisualState, number> = {
  listening: 22,
  thinking: 20,
  working: 18,
  needs: 21,
  done: 16,
  error: 17,
  paused: 15,
};
const SPEED: Record<OrbVisualState, number> = {
  listening: 0.9,
  thinking: 2.2,
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
  private cursor: { x: number; y: number } | null = null;

  constructor(
    private readonly context: CanvasRenderingContext2D,
    public reducedMotion: boolean,
    count = 80,
  ) {
    this.particles = Array.from({ length: count }, () => ({
      theta: Math.random() * Math.PI * 2,
      phi: Math.acos(2 * Math.random() - 1),
      speed: 0.4 + Math.random() * 0.8,
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

  draw(now: number, width: number, height: number): void {
    const context = this.context;
    context.clearRect(0, 0, width, height);
    const [light, deep] = COLORS[this.state];
    const time = now / 1000;
    const anchor = this.cursor ?? this.center;
    const radius = this.cursor ? 7 : this.radiusAt(time);
    const speed = this.reducedMotion ? 0 : SPEED[this.state] * (this.cursor ? 1.8 : 1);
    for (const particle of this.particles) {
      particle.theta += 0.016 * speed * particle.speed;
      const r = radius + this.wobble(time, particle.phase);
      const sinPhi = Math.sin(particle.phi);
      const tx = anchor.x + r * sinPhi * Math.cos(particle.theta);
      const ty = anchor.y + r * Math.cos(particle.phi);
      const depth = (sinPhi * Math.sin(particle.theta) + 1) / 2;
      this.follow(particle, tx, ty);
      context.globalAlpha = 0.35 + 0.65 * depth;
      context.fillStyle = particle.phase > Math.PI ? light : deep;
      context.beginPath();
      context.arc(particle.x, particle.y, 1.1 + depth * 1.6, 0, Math.PI * 2);
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
    if (this.state === "thinking") return 7 * Math.sin(time * 3 + phase);
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
      if (age > SPARK_MS) {
        this.sparks.splice(index, 1);
        continue;
      }
      context.globalAlpha = 1 - age / SPARK_MS;
      context.fillStyle = color;
      context.beginPath();
      context.arc(spark.x + spark.vx * age, spark.y + spark.vy * age, 1.6, 0, Math.PI * 2);
      context.fill();
    }
  }
}

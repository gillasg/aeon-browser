import { useEffect, useRef, type ReactElement } from "react";

// The orb's swarm, small: Aeon's mark on its own pages (top bar, ask box, running cards).
// The one vivid thing on Aeon's pages. Holds still when motion is reduced.

export type SwarmTone = "idle" | "working" | "needs";

const COLORS: Record<SwarmTone, [string, string]> = {
  idle: ["#9b8cff", "#4a2fd0"],
  working: ["#9b8cff", "#4a2fd0"],
  needs: ["#ffd27a", "#ff8a00"],
};

interface Dot {
  theta: number;
  phi: number;
  speed: number;
  light: boolean;
}

export function MiniSwarm({
  size = 22,
  tone = "idle",
}: {
  size?: number;
  tone?: SwarmTone;
}): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    return animate(context, size, tone);
  }, [size, tone]);
  return (
    <canvas
      ref={canvas}
      className="mini-swarm"
      width={size * 2}
      height={size * 2}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

function animate(context: CanvasRenderingContext2D, size: number, tone: SwarmTone): () => void {
  const dots: Dot[] = Array.from({ length: size < 30 ? 36 : 60 }, () => ({
    theta: Math.random() * Math.PI * 2,
    phi: Math.acos(2 * Math.random() - 1),
    speed: 0.4 + Math.random() * 0.8,
    light: Math.random() > 0.5,
  }));
  context.setTransform(2, 0, 0, 2, 0, 0);
  const still = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  let frame = 0;
  const draw = (): void => {
    paint(context, dots, size, tone);
    if (!still) {
      for (const dot of dots) dot.theta += 0.016 * (tone === "idle" ? 0.8 : 1.6) * dot.speed;
      frame = requestAnimationFrame(draw);
    }
  };
  draw();
  return () => cancelAnimationFrame(frame);
}

function paint(
  context: CanvasRenderingContext2D,
  dots: readonly Dot[],
  size: number,
  tone: SwarmTone,
): void {
  const [light, deep] = COLORS[tone];
  const radius = size * 0.28;
  context.clearRect(0, 0, size, size);
  for (const dot of dots) {
    const x = radius * Math.sin(dot.phi) * Math.cos(dot.theta);
    const y = radius * Math.cos(dot.phi);
    const depth = (Math.sin(dot.phi) * Math.sin(dot.theta) + 1) / 2;
    context.globalAlpha = 0.35 + 0.65 * depth;
    context.fillStyle = dot.light ? light : deep;
    context.beginPath();
    context.arc(size / 2 + x, size / 2 + y, 0.6 + depth * (size < 30 ? 0.9 : 1.2), 0, Math.PI * 2);
    context.fill();
  }
}

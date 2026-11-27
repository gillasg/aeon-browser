import { useEffect, useRef, type ReactElement } from "react";
import { runVisibleFrames } from "./visible-work.js";

// The orb's swarm, small: Graft's mark on its own pages (home, running cards, the chat's steps).
// Points spread evenly over a sphere that turns slowly; the near side is lighter, so it reads as
// a lit globe. The one vivid thing on Graft's pages. Holds still when motion is reduced.

export type SwarmTone = "idle" | "working" | "needs";

/** [near side, far side], used when the page has no swarm tokens. */
const FALLBACK: Record<SwarmTone, [string, string]> = {
  idle: ["#c4b5fd", "#7c5cf0"],
  working: ["#c4b5fd", "#7c5cf0"],
  needs: ["#ffe2a8", "#e08a00"],
};

/** Milliseconds per radian of turn. */
const PACE: Record<SwarmTone, number> = { idle: 2600, working: 1100, needs: 1800 };

type Point = readonly [number, number, number];

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
    return animate(context, size, tone, shades(context.canvas, tone), context.canvas);
  }, [size, tone]);
  return (
    <canvas
      ref={canvas}
      className="mini-swarm"
      data-tone={tone}
      width={size * 2}
      height={size * 2}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

/** Points on a Fibonacci spiral: even spacing, no clumps. */
export function spherePoints(count: number): Point[] {
  return Array.from({ length: count }, (_, index) => {
    const y = 1 - (index / (count - 1)) * 2;
    const ring = Math.sqrt(1 - y * y);
    const turn = index * 2.39996;
    return [Math.cos(turn) * ring, y, Math.sin(turn) * ring] as const;
  });
}

/** The theme's shades for this tone, from the canvas's own color and border color. */
function shades(canvas: HTMLCanvasElement, tone: SwarmTone): [string, string] {
  const style = getComputedStyle(canvas);
  const near = style.color;
  const far = style.borderTopColor;
  return near && far && near !== far ? [near, far] : FALLBACK[tone];
}

function animate(
  context: CanvasRenderingContext2D,
  size: number,
  tone: SwarmTone,
  colors: [string, string],
  canvas: HTMLCanvasElement,
): () => void {
  const points = spherePoints(size < 30 ? 30 : size < 60 ? 60 : 90);
  context.setTransform(2, 0, 0, 2, 0, 0);
  const still = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const draw = (time: number): void => paint(context, points, size, colors, time / PACE[tone]);
  // One still frame keeps the mark from ever flashing blank; the gated loop only runs while the
  // page is on screen, and slowly enough that 20 fps looks identical to 60.
  draw(still ? 0.6 * PACE[tone] : performance.now());
  if (still) return () => {};
  // A slow 16px globe: 8 fps is smooth here and costs a third of a 60 fps canvas loop. Combined
  // with the visibility gate, a hidden or off-screen swarm schedules no frames at all.
  return runVisibleFrames(canvas, draw, 8);
}

function paint(
  context: CanvasRenderingContext2D,
  points: readonly Point[],
  size: number,
  [near, far]: [string, string],
  angle: number,
): void {
  const center = size / 2;
  const radius = size * 0.36;
  const dot = Math.max(0.55, size / 44);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  context.clearRect(0, 0, size, size);
  for (const [x, y, z] of points) {
    const turnedX = x * cos - z * sin;
    const depth = (x * sin + z * cos + 1.6) / 2.6;
    context.globalAlpha = 0.25 + 0.75 * depth;
    context.fillStyle = depth > 0.6 ? near : far;
    context.beginPath();
    context.arc(center + turnedX * radius, center + y * radius, dot * depth, 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;
}

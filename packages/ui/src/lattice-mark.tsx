import { useEffect, useRef, type ReactElement } from "react";

// Aeon's mark on home: a globe drawn as dotted latitude and longitude lines. It turns very slowly
// at rest and faster while agents work. The orb on web pages stays the nebula swarm.

type Point = readonly [number, number, number];

/** [near side, far side], used when the page has no lattice tokens. */
const FALLBACK: [string, string] = ["#f1eefc", "#7c5cf0"];
const TILT = -0.42;
/** Milliseconds per radian of turn: at rest, and while agents work. */
const PACE = { rest: 24000, working: 6000 };
/** The starting angle, so its lines don't sit edge-on. */
const REST = 0.3;

export function LatticeMark({
  size = 120,
  turning = false,
}: {
  size?: number;
  turning?: boolean;
}): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    return animate(context, size, turning, shades(context.canvas));
  }, [size, turning]);
  return (
    <canvas
      ref={canvas}
      className="lattice-mark"
      width={size * 2}
      height={size * 2}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

/** Dots along five latitude lines and six meridians; denser on larger marks. */
export function latticePoints(size: number): Point[] {
  const step = Math.max(24, Math.min(96, Math.round(size * 0.6)));
  const points: Point[] = [];
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = Math.sin((lat * Math.PI) / 180);
    const ring = Math.cos((lat * Math.PI) / 180);
    for (let index = 0; index < step; index += 1) {
      const turn = (index / step) * Math.PI * 2;
      points.push([Math.cos(turn) * ring, y, Math.sin(turn) * ring]);
    }
  }
  for (let lon = 0; lon < 180; lon += 30) {
    const phi = (lon * Math.PI) / 180;
    for (let index = 0; index < step; index += 1) {
      const turn = (index / step) * Math.PI * 2;
      points.push([Math.cos(turn) * Math.cos(phi), Math.sin(turn), Math.cos(turn) * Math.sin(phi)]);
    }
  }
  return points;
}

function shades(canvas: HTMLCanvasElement): [string, string] {
  const style = getComputedStyle(canvas);
  const near = style.color;
  const far = style.borderTopColor;
  return near && far && near !== far ? [near, far] : FALLBACK;
}

function animate(
  context: CanvasRenderingContext2D,
  size: number,
  turning: boolean,
  colors: [string, string],
): () => void {
  const points = latticePoints(size);
  context.setTransform(2, 0, 0, 2, 0, 0);
  const still = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const pace = turning ? PACE.working : PACE.rest;
  let frame = 0;
  const start = performance.now();
  const draw = (time: number): void => {
    paint(context, points, size, colors, REST + (time - start) / pace);
    if (!still) frame = requestAnimationFrame(draw);
  };
  draw(start);
  return () => cancelAnimationFrame(frame);
}

function paint(
  context: CanvasRenderingContext2D,
  points: readonly Point[],
  size: number,
  [near, far]: [string, string],
  angle: number,
): void {
  const center = size / 2;
  const radius = size * 0.44;
  const dot = Math.max(0.7, size / 110);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const tiltCos = Math.cos(TILT);
  const tiltSin = Math.sin(TILT);
  context.clearRect(0, 0, size, size);
  for (const [x, y0, z0] of points) {
    const y = y0 * tiltCos - z0 * tiltSin;
    const z = y0 * tiltSin + z0 * tiltCos;
    const depth = (x * sin + z * cos + 1) / 2;
    context.globalAlpha = 0.12 + 0.85 * depth * depth;
    context.fillStyle = depth > 0.55 ? near : far;
    const px = center + (x * cos - z * sin) * radius;
    const py = center + y * radius;
    context.fillRect(px - dot / 2, py - dot / 2, dot, dot);
  }
  context.globalAlpha = 1;
}

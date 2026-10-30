import type { ReactElement } from "react";
import { LatticeMark } from "./lattice-mark.js";

// The top of home, where a logo would sit: the lattice. Slow at rest, turning faster while agents
// work (one size for both, so it does not jump once connected), smaller when many run.

export type HomeCoreMode = "idle" | "working" | "needs";

/** From this many running chats the lattice steps down to its small size. */
const BUSY = 4;

export function HomeCore({
  working,
  waiting,
  connecting = false,
}: {
  working: number;
  waiting: number;
  /** Still reaching the helper app: the lattice turns instead of a "Connecting…" line. */
  connecting?: boolean;
}): ReactElement {
  const mode: HomeCoreMode = waiting ? "needs" : working || connecting ? "working" : "idle";
  const size = working + waiting >= BUSY ? 84 : 132;
  return (
    <header className="home-core" data-mode={mode} aria-hidden="true">
      <LatticeMark size={size} turning={mode !== "idle"} />
    </header>
  );
}

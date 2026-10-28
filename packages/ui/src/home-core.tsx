import type { ReactElement } from "react";
import { MiniSwarm } from "./mini-swarm.js";

// The top of home: Aeon's presence. A large swarm that stirs while an agent works and turns warm
// when one is waiting on you.

export type HomeCoreMode = "idle" | "working" | "needs";

export function HomeCore({
  working,
  waiting,
  connecting = false,
}: {
  working: number;
  waiting: number;
  /** Still reaching the helper app: the swarm stirs instead of a "Connecting…" line. */
  connecting?: boolean;
}): ReactElement {
  const mode: HomeCoreMode = waiting ? "needs" : working || connecting ? "working" : "idle";
  return (
    <header className="home-core" data-mode={mode} aria-hidden="true">
      <MiniSwarm size={120} tone={mode} />
    </header>
  );
}

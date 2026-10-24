import type { ReactElement } from "react";

// The top of home: Aeon's presence. A slow breathing core that quickens while an agent works and
// turns warm when one is waiting on you, with a greeting that says what is going on.

export type HomeCoreMode = "idle" | "working" | "needs";

export function HomeCore({ working, waiting }: { working: number; waiting: number }): ReactElement {
  const mode: HomeCoreMode = waiting ? "needs" : working ? "working" : "idle";
  return (
    <header className="home-core" data-mode={mode}>
      <div className="home-core-orb" aria-hidden="true">
        <span className="home-core-halo" />
        <span className="home-core-ring" />
        <span className="home-core-ring home-core-ring-outer" />
        <span className="home-core-nucleus" />
      </div>
      <h1 className="home-core-greeting">{greeting(new Date().getHours())}</h1>
      <p className="home-core-status" role="status">
        {statusLine(working, waiting)}
      </p>
    </header>
  );
}

export function greeting(hour: number): string {
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export function statusLine(working: number, waiting: number): string {
  if (waiting)
    return waiting === 1 ? "One task is waiting on you." : `${waiting} tasks are waiting on you.`;
  if (working)
    return working === 1 ? "Working on one thing." : `Working on ${working} things at once.`;
  return "Your browser, ready to act.";
}

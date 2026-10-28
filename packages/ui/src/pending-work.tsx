import { useEffect, useState, type ReactElement } from "react";
import { MiniSwarm } from "./mini-swarm.js";

// Motion, not status text: while Aeon connects or starts, the swarm says so; the words stay for
// screen readers. Once work has started, the elapsed time is real information, so it shows.
export function PendingWork({
  connecting = false,
  preparing = false,
}: {
  connecting?: boolean;
  preparing?: boolean;
}): ReactElement {
  const [start] = useState(Date.now),
    [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (connecting || preparing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [connecting, preparing]);
  const waiting = connecting || preparing;
  return (
    <div className="activity-card pending-work" role="status" data-waiting={String(waiting)}>
      <MiniSwarm size={18} tone="working" />
      {waiting ? (
        <span className="aeon-sr">{connecting ? "Connecting…" : "Starting…"}</span>
      ) : (
        <span>{`Working for ${Math.floor((now - start) / 1000)}s`}</span>
      )}
    </div>
  );
}

/** The same quiet swarm where a control is not ready yet (models loading, connecting). */
export function QuietWait({ label }: { label: string }): ReactElement {
  return (
    <span className="model-loading quiet-wait" role="status">
      <MiniSwarm size={16} tone="working" />
      <span className="aeon-sr">{label}</span>
    </span>
  );
}

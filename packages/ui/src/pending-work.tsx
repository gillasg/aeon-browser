import { useEffect, useState, type ReactElement } from "react";
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
  return (
    <div className="activity-card pending-work" role="status">
      {connecting
        ? "Connecting…"
        : preparing
          ? "Starting…"
          : `Working for ${Math.floor((now - start) / 1000)}s`}
    </div>
  );
}

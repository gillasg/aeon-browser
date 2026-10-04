import { useEffect, useState, type ReactElement } from "react";
export function PendingWork(): ReactElement {
  const [start] = useState(Date.now),
    [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="activity-card pending-work" role="status">
      Working for {Math.floor((now - start) / 1000)}s
    </div>
  );
}

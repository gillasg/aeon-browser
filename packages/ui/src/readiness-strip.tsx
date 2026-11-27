import { useEffect, useState, type ReactElement } from "react";
import { chromeFlagPurpose, chromeRelaunchCommand } from "@graft/protocol";

// One quiet line under the cursor box when something needs the user: the daemon link stays
// offline, or Chrome runs without Graft's optional flags. Nothing shows when all is ready; no tour.
// The model nudge is the Connect model card below the box, so it is not repeated here.

const DISMISS_KEY = "graftFlagsNoticeDismissed";
/** The daemon gets this long to answer before the hint shows; a normal connect is faster. */
export const OFFLINE_HINT_DELAY_MS = 4000;

export function ReadinessStrip(props: {
  connected?: boolean | undefined;
  missingChromeFlags?: readonly string[] | undefined;
  platform: string;
  /** Tests skip the wait. */
  offlineDelayMs?: number;
}): ReactElement | null {
  const offline = useLateOffline(props.connected, props.offlineDelayMs ?? OFFLINE_HINT_DELAY_MS);
  const missing = props.missingChromeFlags ?? [];
  const key = missing.join(" ");
  const [dismissed, setDismissed] = useState(() => readDismissed() === key);
  if (offline)
    return (
      <p className="readiness-strip" role="status">
        Graft's daemon isn't answering. In a terminal run <code>graft doctor</code>, or{" "}
        <code>graft setup --again</code> if it was never set up.
      </p>
    );
  if (!missing.length || dismissed) return null;
  const command = chromeRelaunchCommand(props.platform, missing);
  return (
    <div className="readiness-strip" role="note">
      <p>
        Optional: Chrome runs without{" "}
        {missing.map((flag) => chromeFlagPurpose(flag).replace(/^\w+ /, "")).join(", ")}. Quit
        Chrome and relaunch it with:
      </p>
      <code className="readiness-command">{command}</code>
      <span className="readiness-actions">
        <button type="button" onClick={() => void navigator.clipboard?.writeText(command)}>
          Copy
        </button>
        <button
          type="button"
          onClick={() => {
            writeDismissed(key);
            setDismissed(true);
          }}
        >
          Dismiss
        </button>
      </span>
    </div>
  );
}

function useLateOffline(connected: boolean | undefined, delay: number): boolean {
  const [late, setLate] = useState(connected === false && delay <= 0);
  useEffect(() => {
    if (connected !== false) return setLate(false);
    if (delay <= 0) return setLate(true);
    const timer = setTimeout(() => setLate(true), delay);
    return () => clearTimeout(timer);
  }, [connected, delay]);
  return connected === false && late;
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(value: string): void {
  try {
    localStorage.setItem(DISMISS_KEY, value);
  } catch {
    /* Hidden for this view only. */
  }
}

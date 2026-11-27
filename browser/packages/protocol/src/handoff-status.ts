// "Waiting on you: <msg>" — one wording for a pending hand-off wherever it is shown: the tab
// list, `graft tabs`, `graft status`, the daemon's activity line and the cursor box.

export interface HandoffStatus {
  message: string;
  startedAt: number;
}

const CLIP = 80;

/** 2m 10s, 45s, 1h 3m. */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** The request, on one line, clipped to 80 characters. */
export function clipHandoffMessage(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length > CLIP ? line.slice(0, CLIP - 1) + "…" : line;
}

/** "Waiting on you: Sign in to continue (2m 10s)". */
export function handoffStatusLine(status: HandoffStatus, now = Date.now()): string {
  return `Waiting on you: ${clipHandoffMessage(status.message)} (${elapsedLabel(now - status.startedAt)})`;
}

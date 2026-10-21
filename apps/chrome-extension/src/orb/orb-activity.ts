import { appendActivity, describeWrites } from "@aeon/ui";
import type { OrbRun } from "./orb-run.js";
import { WRITE_KINDS } from "./orb-watch.js";

// Logs a finished run to Activity when it changed something on the site (typed, submitted,
// uploaded…). Stand-in until Core records writes itself; see @aeon/ui activity-log.

export function logWrites(run: OrbRun, info: { chatId: string; host: string; task: string }): void {
  const kinds = run.actions.filter((action) => !action.failed && WRITE_KINDS.test(action.kind));
  const summary = describeWrites(kinds.map((action) => action.kind));
  if (!summary) return;
  appendActivity({
    id: info.chatId + ":" + (kinds[0]?.tStart ?? Date.now()),
    at: new Date().toISOString(),
    chatId: info.chatId,
    host: info.host,
    task: info.task,
    summary: summary.charAt(0).toUpperCase() + summary.slice(1),
  });
}

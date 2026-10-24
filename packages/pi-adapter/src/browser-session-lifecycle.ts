import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { BrowserToolRunner } from "./browser-tool.js";
import { finishRunLog, startRunLog } from "./run-log.js";

// A follow-up often arrives seconds after the previous answer. Keep the tabs and their variables
// alive through a short gap: release the run now, but tidy only after this delay, and cancel the
// tidy when the same chat starts another run.
const DEFAULT_TIDY_DELAY_MS = 120_000;
const tidyTimers = new Map<string, ReturnType<typeof setTimeout>>();

export interface BrowserSessionLifecycleOptions {
  /** Tests shorten the delay; production uses two minutes. */
  tidyDelayMs?: number;
  /** The chat's workspace: each run's log is written under runs/ there. */
  workspace?: string;
}

export function installBrowserSessionLifecycle(
  session: AgentSession,
  chatId: string,
  run?: BrowserToolRunner,
  options: BrowserSessionLifecycleOptions = {},
): void {
  const delay = options.tidyDelayMs ?? DEFAULT_TIDY_DELAY_MS;
  session.subscribe((event) => {
    if (event.type === "agent_start") {
      cancelTidy(chatId);
      startRunLog(chatId);
      return;
    }
    if (event.type !== "agent_end") return;
    cancelTidy(chatId);
    // The run's log is finished first: it is what the user and a later agent read back.
    void finishRunLog(chatId, options.workspace).catch(() => undefined);
    if (!run) return;
    // Release the finished run immediately; closing its tabs waits so a quick follow-up can
    // reuse its variables and pages.
    void run(chatId, "browser-turn-cleanup", { release: true }).catch(() => undefined);
    const timer = setTimeout(() => {
      tidyTimers.delete(chatId);
      void run(chatId, "browser-turn-cleanup", { release: true, tidy: true }).catch(
        () => undefined,
      );
    }, delay);
    tidyTimers.set(chatId, timer);
  });
}

function cancelTidy(chatId: string): void {
  const timer = tidyTimers.get(chatId);
  if (!timer) return;
  clearTimeout(timer);
  tidyTimers.delete(chatId);
}

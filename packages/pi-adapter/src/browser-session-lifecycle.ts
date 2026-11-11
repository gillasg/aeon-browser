import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { BrowserToolRunner } from "./browser-tool.js";
import { finishRunLog, sealRunLog, settleRunLogs, startRunLog, unsealRunLog } from "./run-log.js";

// A follow-up often arrives seconds after the previous answer. Keep the tabs and their variables
// alive through a short gap: release the run now, but tidy only after this delay, and cancel the
// tidy when the same chat starts another run.
const DEFAULT_TIDY_DELAY_MS = 120_000;
const tidyTimers = new Map<string, ReturnType<typeof setTimeout>>();
const closers = new WeakMap<object, () => Promise<void>>();

export interface BrowserSessionLifecycleOptions {
  /** Tests shorten the delay; production uses two minutes. */
  tidyDelayMs?: number;
  /** The chat's workspace: each run's log is written under runs/ there. */
  workspace?: string;
  /** Tests hold the end-of-run log write so close can run while that write is still pending. */
  holdRunLog?: Promise<void>;
}

/** Stop listening and finish this chat's run-log writes. A closed chat writes nothing further. */
export function closeBrowserSessionLifecycle(session: object): Promise<void> {
  const close = closers.get(session);
  return close ? close() : Promise.resolve();
}

export function installBrowserSessionLifecycle(
  session: AgentSession,
  chatId: string,
  run?: BrowserToolRunner,
  options: BrowserSessionLifecycleOptions = {},
): void {
  const delay = options.tidyDelayMs ?? DEFAULT_TIDY_DELAY_MS;
  let closed = false;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  const unsubscribe = session.subscribe((event) => {
    if (closed) return;
    onSessionEvent(event, chatId, run, delay, options, pending, () => closed);
  });
  closers.set(session, () => {
    if (closing) return closing;
    closed = true;
    unsubscribe();
    cancelTidy(chatId);
    closing = drainRun(chatId, pending);
    return closing;
  });
}

function onSessionEvent(
  event: AgentSessionEvent,
  chatId: string,
  run: BrowserToolRunner | undefined,
  delay: number,
  options: BrowserSessionLifecycleOptions,
  pending: Set<Promise<void>>,
  isClosed: () => boolean,
): void {
  if (event.type === "agent_start") {
    cancelTidy(chatId);
    unsealRunLog(chatId);
    startRunLog(chatId);
    return;
  }
  if (event.type !== "agent_end") return;
  endRun(chatId, run, delay, options, pending, isClosed);
}

function endRun(
  chatId: string,
  run: BrowserToolRunner | undefined,
  delay: number,
  options: BrowserSessionLifecycleOptions,
  pending: Set<Promise<void>>,
  isClosed: () => boolean,
): void {
  cancelTidy(chatId);
  // The run's log is finished first: it is what the user and a later agent read back.
  track(pending, observedRunLog(chatId, options));
  if (!run) return;
  // Release the finished run immediately; closing its tabs waits so a quick follow-up can
  // reuse its variables and pages.
  track(pending, quiet(run(chatId, "browser-turn-cleanup", { release: true })));
  const timer = setTimeout(() => {
    tidyTimers.delete(chatId);
    if (isClosed()) return;
    track(pending, quiet(run(chatId, "browser-turn-cleanup", { release: true, tidy: true })));
  }, delay);
  tidyTimers.set(chatId, timer);
}

async function observedRunLog(
  chatId: string,
  options: BrowserSessionLifecycleOptions,
): Promise<void> {
  if (options.holdRunLog) await options.holdRunLog;
  await finishRunLog(chatId, options.workspace).catch(() => undefined);
}

function track(pending: Set<Promise<void>>, work: Promise<void>): void {
  const done = quiet(work);
  pending.add(done);
  void done.finally(() => pending.delete(done));
}

function quiet(work: Promise<unknown>): Promise<void> {
  return work.then(
    () => undefined,
    () => undefined,
  );
}

/** In-flight writes finish; a seal then refuses any write that starts afterwards. */
async function drainRun(chatId: string, pending: Set<Promise<void>>): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
  sealRunLog(chatId);
  await settleRunLogs(chatId);
}

function cancelTidy(chatId: string): void {
  const timer = tidyTimers.get(chatId);
  if (!timer) return;
  clearTimeout(timer);
  tidyTimers.delete(chatId);
}

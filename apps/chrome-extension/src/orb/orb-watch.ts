import type { OrbRun } from "./orb-run.js";

// Watch turns a finished task into a routine (the existing routines system: storage, schedule,
// notifications and auto-pause all live there). A read-only check is created directly; anything
// that clicked through the page opens the routine editor so the user confirms it first.

export const WATCH_EVERY_MINUTES = 15;

export type OrbWatchPlan =
  { kind: "direct" } | { kind: "editor" } | { kind: "none"; reason: string };

// Trace action kinds that change something on the page (typing, choosing, sending).
const WRITE_KINDS = /fill|type|insert|press|key|select|check|upload|drop|drag|submit/i;
const CLICK_KINDS = /click|tap/i;

export function watchPlan(run: OrbRun): OrbWatchPlan {
  if (run.asked || run.actions.some((action) => WRITE_KINDS.test(action.kind)))
    return {
      kind: "none",
      reason: "Can't watch this: it changes things on the site, so repeating it isn't safe.",
    };
  const stableRead = run.steps.some(
    (step) => step.done && !step.isError && step.path !== undefined && step.path !== "ui",
  );
  if (!stableRead)
    return {
      kind: "none",
      reason: "Can't watch this: it read the page by hand, so there's no stable read to repeat.",
    };
  return run.actions.some((action) => CLICK_KINDS.test(action.kind))
    ? { kind: "editor" }
    : { kind: "direct" };
}

export interface WatchRoutine {
  title: string;
  instruction: string;
  schedule: { kind: "interval"; everyMinutes: number; timeZone: string };
}

export function watchRoutine(prompt: string): WatchRoutine {
  const task = prompt.trim();
  return {
    title: clip("Watch: " + task, 120),
    instruction:
      task +
      "\n\nThis runs as a watcher. Compare with the previous check and report only what changed;" +
      " if nothing changed, say so in one line.",
    schedule: {
      kind: "interval",
      everyMinutes: WATCH_EVERY_MINUTES,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  };
}

/** home.html opens its routine editor prefilled from `routineDraft` (see @aeon/ui routine-draft-route). */
export function routineEditorUrl(base: string, chatId: string, routine: WatchRoutine): string {
  const url = new URL(base);
  url.searchParams.set("view", "routines");
  url.searchParams.set("chatId", chatId);
  url.searchParams.set(
    "routineDraft",
    JSON.stringify({
      chatId,
      title: routine.title,
      instruction: routine.instruction,
      everyMinutes: routine.schedule.everyMinutes,
    }),
  );
  return url.href;
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

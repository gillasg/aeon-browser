import type { PiMessageDto, PiSessionEventDto } from "@aeon/protocol";

// One agent run, built only from the chat stream in @aeon/protocol. The orb's island and the
// shared run cards (step timeline, approval, result) all read it.
//
// Stand-ins until the engine sends dedicated data (each is marked `mocked` where it is used):
// - tool-end.path missing: guessed from the tool name (inferPath).
// - tool-end.durationMs missing: tool-end time minus tool-start time.
// - Live cursor positions: there is no per-action event yet, so the cursor replays the trace
//   actions (box/point) of a tool call when its result message arrives.
// - Action tab: actions without tabId are assumed to be in the viewer's tab.
// - Spotlight target: the last action with a box (or point) before the run asked for the user.

export type RunPath = "recipe" | "site-mapper" | "data" | "url" | "read" | "ui";
export type RunStatus = "idle" | "thinking" | "working" | "needs" | "done" | "error";

export interface RunStep {
  toolCallId: string;
  toolName: string;
  label: string;
  startedAt: number;
  done: boolean;
  durationMs?: number;
  durationMocked?: boolean;
  path?: RunPath;
  pathMocked?: boolean;
  isError?: boolean;
  /** A long job inside this one call, as the tool reports it ("Removing 47/77"). */
  progress?: RunProgress;
}

export interface RunProgress {
  done: number;
  total?: number | undefined;
  label?: string | undefined;
}

/** "Removing 47/77", or "47 done" when the total isn't known. */
export function formatProgress(progress: RunProgress): string {
  const count =
    progress.total !== undefined ? `${progress.done}/${progress.total}` : `${progress.done} done`;
  return progress.label ? `${progress.label} ${count}` : count;
}

export interface RunBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RunAction {
  toolCallId: string;
  kind: string;
  tabId?: number;
  visible?: boolean;
  tStart: number;
  tAct?: number;
  point?: { x: number; y: number };
  box?: RunBox;
  failed?: boolean;
}

export interface AgentRun {
  status: RunStatus;
  label: string;
  steps: RunStep[];
  actions: RunAction[];
  answer: string;
  dialog?: { title: string; message: string | null };
  /** The run stopped to ask the user something (approvals are for writes: pay, order, send). */
  asked?: boolean;
  /** The user stopped the run (Pi recorded it as aborted). */
  stopped?: boolean;
  error?: string;
}

export interface RunCursorStep {
  kind: string;
  x: number;
  y: number;
  delayMs: number;
}

export function initialRun(): AgentRun {
  return { status: "thinking", label: "Thinking", steps: [], actions: [], answer: "" };
}

type Handler<K extends PiSessionEventDto["kind"]> = (
  run: AgentRun,
  event: Extract<PiSessionEventDto, { kind: K }>,
  now: number,
) => AgentRun;

const handlers: { [K in PiSessionEventDto["kind"]]?: Handler<K> } = {
  "tool-start": (run, event, now) =>
    event.parentToolCallId
      ? run
      : {
          ...run,
          status: "working",
          label: describeTool(event.toolName, event.arguments),
          steps: [
            ...run.steps,
            {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              label: describeTool(event.toolName, event.arguments),
              startedAt: now,
              done: false,
            },
          ],
        },
  "tool-update": (run, event) => {
    const progress = event.progress;
    if (event.parentToolCallId || !progress) return run;
    return {
      ...run,
      steps: run.steps.map((step) =>
        step.toolCallId === event.toolCallId ? { ...step, progress } : step,
      ),
    };
  },
  "tool-end": (run, event, now) =>
    event.parentToolCallId
      ? run
      : { ...run, steps: run.steps.map((step) => endStep(step, event, now)) },
  // The protocol builds the three message events from one schema, so their kinds don't narrow.
  "message-end": (run, event) =>
    applyMessage(run, (event as unknown as { message: PiMessageDto }).message),
  "entry-added": (run, event) =>
    event.entry.message ? applyMessage(run, event.entry.message) : run,
  "run-state": (run, event) => applyRunState(run, event.state),
  "turn-boundary": (run, event) =>
    event.active ? { ...run, status: "thinking", label: "Thinking" } : finish(run),
  "extension-ui-request": (run, event) => ({
    ...run,
    status: "needs",
    label: "Needs you",
    asked: true,
    dialog: { title: event.request.title, message: event.request.message },
  }),
  "extension-ui-resolved": (run) => {
    const next: AgentRun = { ...run, status: "working", label: "Continuing" };
    delete next.dialog;
    return next;
  },
};

export function applyEvent(run: AgentRun, event: PiSessionEventDto, now: number): AgentRun {
  const handler = handlers[event.kind] as Handler<typeof event.kind> | undefined;
  return handler ? handler(run, event as never, now) : run;
}

function endStep(
  step: RunStep,
  event: Extract<PiSessionEventDto, { kind: "tool-end" }>,
  now: number,
): RunStep {
  if (step.toolCallId !== event.toolCallId) return step;
  const path = event.path ?? inferPath(step.toolName);
  return {
    ...step,
    done: true,
    isError: event.isError,
    durationMs: event.durationMs ?? Math.max(0, Math.round(now - step.startedAt)),
    durationMocked: event.durationMs === undefined,
    path,
    pathMocked: event.path === undefined,
  };
}

function applyMessage(run: AgentRun, message: PiMessageDto): AgentRun {
  if (message.role === "tool") return addActions(run, message);
  if (message.role !== "assistant") return run;
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
  // A run the user stopped settles like any other, but says so in every view.
  if (message.stopReason === "aborted") return { ...run, stopped: true };
  if (message.stopReason === "error")
    return { ...run, status: "error", error: message.errorMessage ?? "The run failed." };
  return text ? { ...run, answer: text } : run;
}

function addActions(run: AgentRun, message: PiMessageDto): AgentRun {
  const id = message.toolCallId;
  if (!id || !message.actions?.length || run.actions.some((item) => item.toolCallId === id))
    return run;
  const added = message.actions.map((action) => ({
    toolCallId: id,
    kind: action.kind,
    tStart: action.tStart,
    ...(action.tabId !== undefined ? { tabId: action.tabId } : {}),
    ...(action.visible !== undefined ? { visible: action.visible } : {}),
    ...(action.tAct !== undefined ? { tAct: action.tAct } : {}),
    ...(action.point ? { point: action.point } : {}),
    ...(action.box ? { box: action.box } : {}),
    ...(action.failed ? { failed: true } : {}),
  }));
  return { ...run, actions: [...run.actions, ...added] };
}

function applyRunState(run: AgentRun, state: string): AgentRun {
  if (state === "needs_attention") return { ...run, status: "needs", label: "Needs you" };
  if (state === "idle") return finish(run);
  return run.status === "idle" || run.status === "done" ? { ...run, status: "thinking" } : run;
}

function finish(run: AgentRun): AgentRun {
  if (run.status === "error" || run.status === "needs") return run;
  // An idle chat before the prompt has started is not a finished run.
  if (!run.steps.length && !run.answer) return run;
  return { ...run, status: "done", label: run.stopped ? "Stopped" : "Done" };
}

export function inferPath(toolName: string): RunPath {
  if (toolName === "site_mapper") return "site-mapper";
  if (toolName === "crawl" || toolName === "extract") return "data";
  if (toolName === "read" || toolName === "web_fetch") return "read";
  return "ui";
}

const TOOL_LABELS: Record<string, string> = {
  browser_code: "Working in the page",
  browser_tabs: "Switching tabs",
  crawl: "Reading the site",
  site_mapper: "Using the site's API",
  extract: "Pulling out the data",
};

export function describeTool(toolName: string, args: Record<string, unknown>): string {
  for (const key of ["description", "title", "intent"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return clip(value.trim(), 48);
  }
  return TOOL_LABELS[toolName] ?? clip(sentenceCase(toolName.replace(/[_-]+/g, " ")), 48);
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function onTab(action: RunAction, tabId: number): boolean {
  return (action.tabId === undefined || action.tabId === tabId) && action.visible !== false;
}

function targetOf(action: RunAction): { x: number; y: number } | undefined {
  if (action.point) return action.point;
  if (!action.box) return undefined;
  return { x: action.box.x + action.box.width / 2, y: action.box.y + action.box.height / 2 };
}

/** The cursor path for actions in this tab, paced by their recorded timing (clamped). */
export function cursorSteps(actions: readonly RunAction[], tabId: number): RunCursorStep[] {
  const steps: RunCursorStep[] = [];
  let previous: number | undefined;
  for (const action of actions) {
    const target = targetOf(action);
    if (!target || !onTab(action, tabId) || action.failed) continue;
    const at = action.tAct ?? action.tStart;
    const gap = previous === undefined ? 0 : at - previous;
    steps.push({
      kind: action.kind,
      x: target.x,
      y: target.y,
      delayMs: Math.min(1200, Math.max(previous === undefined ? 0 : 350, gap)),
    });
    previous = at;
  }
  return steps;
}

/** Where to point the user when the run needs them: the last thing it touched in this tab. */
export function spotlightBox(actions: readonly RunAction[], tabId: number): RunBox | undefined {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index];
    if (!action || !onTab(action, tabId)) continue;
    if (action.box) return action.box;
    if (action.point)
      return { x: action.point.x - 24, y: action.point.y - 24, width: 48, height: 48 };
  }
  return undefined;
}

export const PATH_NAMES: Record<RunPath, string> = {
  recipe: "saved recipe",
  "site-mapper": "site API",
  data: "data",
  url: "direct link",
  read: "reading",
  ui: "the page",
};

export function summarize(run: AgentRun): string {
  const done = run.steps.filter((step) => step.done);
  if (!done.length) return "";
  const total = done.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
  const paths = [...new Set(done.flatMap((step) => (step.path ? [PATH_NAMES[step.path]] : [])))];
  const count = `${done.length} step${done.length === 1 ? "" : "s"}`;
  return [count, formatRunDuration(total), paths.length ? "via " + paths.join(", ") : ""]
    .filter(Boolean)
    .join(" · ");
}

export function formatRunDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

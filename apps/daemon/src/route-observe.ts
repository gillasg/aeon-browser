// Folds one chat's session events into the facts a route and a run card are built from.
// A steer while the run is active is a correction. The opening prompt is not.

import type { PiSessionEvent, PiToolStepEvent } from "@aeon/domain";

export interface SeenStep {
  id: string;
  kind: string;
  site: string;
  write: boolean;
  effect?: "confirmed" | "unverifiable" | "suspected_noop" | "refused";
  sensitive?: boolean;
  target?: { role?: string; name?: string; css?: string; text?: string };
  url?: string;
  evidence?: {
    request?: { method: string; path: string; status: number };
    navigated?: string;
    download?: { name: string };
    valueRead?: boolean;
  };
  via?: "page" | "api" | "ability";
}

export interface SeenEvent {
  kind: "run-state" | "user" | "steps" | "error" | "tool" | "answer" | "code";
  state?: string;
  text?: string;
  toolCallId?: string;
  /** browser_code source, captured at tool-start so a finished run can become an ability. */
  code?: string;
  isError?: boolean;
  steps?: SeenStep[];
  progress?: { done: number; total?: number };
  result?: string;
}

/** One browser_code cell in a run, kept until the run settles. */
export interface SeenCell {
  toolCallId: string;
  code: string;
  ok: boolean;
}

export interface LiveRun {
  chatId: string;
  runId: string;
  /** What the user typed, without a draft prefix. */
  userPrompt: string;
  /** The task this run belongs to: the prompt itself, or the one a short correction points at. */
  task: string;
  /** The text submitted, so the opening message is not a correction. */
  submitted: string;
  startedAt: number;
  stepsByTool: Record<string, SeenStep[]>;
  corrected: boolean;
  ours: boolean;
  /** A tool call failed, or a step was refused or found to do nothing. */
  stumbled: boolean;
  usedAbility: boolean;
  fromMemory: boolean;
  /** Rung 1 handed the model a saved draft. This is not a replay. */
  draft: boolean;
  watcher: boolean;
  /** The run ended without a known outcome; it is not a success to learn from. */
  unsure: boolean;
  partial?: { have: number; total: number };
  /** Text every tool result returned, for checking the answer's quotes against what was read. */
  readText: string[];
  /** The answer with no tool call, kept for that check. */
  answer?: string;
  /** browser_code cells, for quietly learning a finished run as an ability. */
  cells: SeenCell[];
}

export interface Absorb {
  run?: LiveRun;
  finish: boolean;
}

const OURS = /\b(INTERNAL|DAEMON_OFFLINE|INPUT_FAILED)\b/;

export function openRun(
  chatId: string,
  runId: string,
  userPrompt: string,
  submitted: string,
  now: number,
): LiveRun {
  return {
    chatId,
    runId,
    userPrompt,
    task: userPrompt,
    submitted,
    startedAt: now,
    stepsByTool: {},
    corrected: false,
    ours: false,
    stumbled: false,
    usedAbility: false,
    fromMemory: false,
    draft: false,
    watcher: false,
    unsure: false,
    readText: [],
    cells: [],
  };
}

/** Returns the run after this event. `finish` is set when the agent has settled. */
export function absorb(run: LiveRun | undefined, event: SeenEvent, now: number): Absorb {
  if (event.kind === "run-state") return onState(run, event.state, now);
  if (!run) return { finish: false };
  return { run: onRunEvent(run, event), finish: false };
}

function onRunEvent(run: LiveRun, event: SeenEvent): LiveRun {
  if (event.kind === "user") return onUser(run, event.text ?? "");
  if (event.kind === "steps") return onSteps(run, event);
  if (event.kind === "code") return onCode(run, event);
  if (event.kind === "tool" || event.kind === "error") return onToolEnd(run, event);
  if (event.kind === "answer") return onAnswer(run, event.text ?? "");
  return run;
}

function onCode(run: LiveRun, event: SeenEvent): LiveRun {
  return {
    ...run,
    cells: [...run.cells, { toolCallId: event.toolCallId ?? "", code: event.code ?? "", ok: true }],
  };
}

function onToolEnd(run: LiveRun, event: SeenEvent): LiveRun {
  const settled = event.toolCallId
    ? run.cells.map((cell) =>
        cell.toolCallId === event.toolCallId ? { ...cell, ok: event.isError === false } : cell,
      )
    : run.cells;
  const next = { ...run, cells: settled };
  if (event.kind === "tool") return onRead(next, event.result ?? "");
  if (OURS.test(event.result ?? "")) return { ...next, ours: true };
  return { ...next, stumbled: true };
}

export function flatSteps(run: LiveRun): SeenStep[] {
  return Object.values(run.stepsByTool).flat();
}

function onState(run: LiveRun | undefined, state: string | undefined, now: number): Absorb {
  if (!run) return { finish: false };
  if (state === "running-unconfirmed" && run.startedAt === 0)
    return { run: { ...run, startedAt: now }, finish: false };
  if (state === "idle") return { run: { ...run, unsure: false }, finish: true };
  if (state === "uncertain") return { run: { ...run, unsure: true }, finish: true };
  return { run, finish: false };
}

function onUser(run: LiveRun, text: string): LiveRun {
  const trimmed = text.trim();
  if (!trimmed || trimmed === run.submitted.trim()) return run;
  return { ...run, corrected: true };
}

const READ_CAP = 400_000;
const READ_TOTAL_CAP = 2_000_000;

function onRead(run: LiveRun, text: string): LiveRun {
  const total = run.readText.reduce((sum, item) => sum + item.length, 0);
  if (!text || total >= READ_TOTAL_CAP) return run;
  const room = Math.min(READ_CAP, READ_TOTAL_CAP - total);
  return { ...run, readText: [...run.readText, text.slice(0, room)] };
}

function onAnswer(run: LiveRun, text: string): LiveRun {
  return text.trim() ? { ...run, answer: text } : run;
}

function onSteps(run: LiveRun, event: SeenEvent): LiveRun {
  const id = event.toolCallId || "tool";
  const steps = event.steps ?? [];
  const partial = partialOf(event.progress) ?? run.partial;
  return {
    ...run,
    stepsByTool: { ...run.stepsByTool, [id]: steps },
    stumbled: run.stumbled || steps.some((step) => stepFailed(step)),
    usedAbility:
      run.usedAbility || steps.some((step) => step.kind === "ability" || step.via === "ability"),
    ...(partial ? { partial } : {}),
  };
}

function stepFailed(step: SeenStep): boolean {
  return step.effect === "refused" || step.effect === "suspected_noop";
}

function partialOf(progress: SeenEvent["progress"]): LiveRun["partial"] | undefined {
  if (!progress || progress.total === undefined || progress.done >= progress.total)
    return undefined;
  return { have: progress.done, total: progress.total };
}

const EFFECTS = new Set<SeenStep["effect"]>([
  "confirmed",
  "unverifiable",
  "suspected_noop",
  "refused",
]);

/** The session events this recorder understands. Anything else is ignored. */
export function seenFrom(event: PiSessionEvent): SeenEvent | undefined {
  if (event.kind === "run-state") return { kind: "run-state", state: event.state };
  if (event.kind === "message-end" && event.message.role === "user")
    return { kind: "user", text: textOf(event.message.content) };
  if (event.kind === "message-end" && event.message.role === "assistant") {
    const called = event.message.content.some((block) => block.type === "tool-call");
    return called ? undefined : { kind: "answer", text: textOf(event.message.content) };
  }
  if (event.kind === "tool-update") return stepsSeen(event.toolCallId, event.steps, event.progress);
  if (event.kind === "tool-start") return codeStart(event);
  if (event.kind === "tool-end")
    return event.isError
      ? { kind: "error", result: event.result, toolCallId: event.toolCallId, isError: true }
      : { kind: "tool", result: event.result, toolCallId: event.toolCallId, isError: false };
  return undefined;
}

function codeStart(event: PiSessionEvent): SeenEvent | undefined {
  if (event.kind !== "tool-start" || event.toolName !== "browser_code") return undefined;
  if (typeof event.arguments.code !== "string") return undefined;
  return { kind: "code", code: event.arguments.code, toolCallId: event.toolCallId };
}

function stepsSeen(
  toolCallId: string,
  steps: readonly PiToolStepEvent[] | undefined,
  progress: { done: number; total?: number } | undefined,
): SeenEvent {
  return {
    kind: "steps",
    toolCallId,
    steps: (steps ?? []).map(seenStep),
    ...(progress ? { progress } : {}),
  };
}

function seenStep(step: PiToolStepEvent): SeenStep {
  const effect = EFFECTS.has(step.effect as SeenStep["effect"])
    ? (step.effect as SeenStep["effect"])
    : undefined;
  return {
    id: step.id,
    kind: step.kind,
    site: step.site,
    write: step.write,
    ...(effect ? { effect } : {}),
    ...(step.sensitive ? { sensitive: true } : {}),
    ...(step.via ? { via: step.via } : {}),
    ...(step.target ? { target: { role: step.target.role, name: step.target.name } } : {}),
    ...(step.evidence?.navigated ? { url: step.evidence.navigated } : {}),
    ...(step.evidence ? { evidence: evidenceOf(step.evidence) } : {}),
  };
}

function evidenceOf(
  evidence: NonNullable<PiToolStepEvent["evidence"]>,
): NonNullable<SeenStep["evidence"]> {
  const copied: NonNullable<SeenStep["evidence"]> = {};
  if (evidence.request) copied.request = evidence.request;
  if (evidence.navigated) copied.navigated = evidence.navigated;
  if (evidence.download) copied.download = evidence.download;
  if (evidence.valueRead) copied.valueRead = true;
  return copied;
}

function textOf(content: readonly { type?: string; text?: string }[]): string {
  return content
    .map((block) => (block.type === "text" && block.text ? block.text : ""))
    .join("\n")
    .trim();
}

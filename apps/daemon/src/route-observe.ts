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
  kind: "run-state" | "user" | "steps" | "error";
  state?: string;
  text?: string;
  toolCallId?: string;
  steps?: SeenStep[];
  progress?: { done: number; total?: number };
  result?: string;
}

export interface LiveRun {
  chatId: string;
  runId: string;
  /** What the user typed, without a draft prefix. */
  userPrompt: string;
  /** The text submitted, so the opening message is not a correction. */
  submitted: string;
  startedAt: number;
  stepsByTool: Record<string, SeenStep[]>;
  corrected: boolean;
  ours: boolean;
  usedAbility: boolean;
  fromMemory: boolean;
  /** Rung 1 handed the model a saved draft. This is not a replay. */
  draft: boolean;
  watcher: boolean;
  partial?: { have: number; total: number };
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
    submitted,
    startedAt: now,
    stepsByTool: {},
    corrected: false,
    ours: false,
    usedAbility: false,
    fromMemory: false,
    draft: false,
    watcher: false,
  };
}

/** Returns the run after this event. `finish` is set when the agent has settled. */
export function absorb(run: LiveRun | undefined, event: SeenEvent, now: number): Absorb {
  if (event.kind === "run-state") return onState(run, event.state, now);
  if (!run) return { finish: false };
  if (event.kind === "user") return { run: onUser(run, event.text ?? ""), finish: false };
  if (event.kind === "steps") return { run: onSteps(run, event), finish: false };
  if (event.kind === "error" && event.result && OURS.test(event.result))
    return { run: { ...run, ours: true }, finish: false };
  return { run, finish: false };
}

export function flatSteps(run: LiveRun): SeenStep[] {
  return Object.values(run.stepsByTool).flat();
}

function onState(run: LiveRun | undefined, state: string | undefined, now: number): Absorb {
  if (!run) return { finish: false };
  if (state === "running-unconfirmed" && run.startedAt === 0)
    return { run: { ...run, startedAt: now }, finish: false };
  if (state === "idle" || state === "uncertain") return { run, finish: true };
  return { run, finish: false };
}

function onUser(run: LiveRun, text: string): LiveRun {
  const trimmed = text.trim();
  if (!trimmed || trimmed === run.submitted.trim()) return run;
  return { ...run, corrected: true };
}

function onSteps(run: LiveRun, event: SeenEvent): LiveRun {
  const id = event.toolCallId || "tool";
  const steps = event.steps ?? [];
  const partial = partialOf(event.progress) ?? run.partial;
  return {
    ...run,
    stepsByTool: { ...run.stepsByTool, [id]: steps },
    usedAbility:
      run.usedAbility || steps.some((step) => step.kind === "ability" || step.via === "ability"),
    ...(partial ? { partial } : {}),
  };
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
  if (event.kind === "tool-update") return stepsSeen(event.toolCallId, event.steps, event.progress);
  if (event.kind === "tool-end" && event.isError) return { kind: "error", result: event.result };
  return undefined;
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

import type { CSSProperties, KeyboardEvent, ReactElement } from "react";
import {
  ApprovalCard,
  formatProgress,
  PATH_NAMES,
  ResultCard,
  StepTimeline,
  type RunProgress,
} from "@aeon/ui";
import { summarize, type OrbRun } from "./orb-run.js";
import { watchPlan } from "./orb-watch.js";

// The island: one black pill that grows into whatever the run needs. Compose at the mouse,
// a live step while working, an approval when it needs you, the result when it's done.

export interface OrbViewModel {
  host: string;
  prompt: string;
  run: OrbRun | undefined;
  notice: string;
  busy: boolean;
  /** Watch progress for the finished run: saving, saved (a routine exists) or a note. */
  watch: { state: "idle" | "saving" | "saved"; note: string };
  /** The user took over: the run was stopped so they can drive. */
  paused: boolean;
  /** The step timeline is open under the live step. */
  expanded: boolean;
  /** Things waiting for the user across open orbs, this one included. */
  needsCount: number;
}

export interface OrbViewActions {
  submit(text: string): void;
  close(): void;
  stop(): void;
  again(): void;
  watch(): void;
  openChat(): void;
  takeOver(): void;
  resume(): void;
  toggleDetails(): void;
}

export type IslandState = "compose" | "working" | "paused" | "needs" | "done" | "error";

export function islandState(model: OrbViewModel): IslandState {
  const run = model.run;
  if (!run) return "compose";
  if (model.paused) return "paused";
  if (run.status === "done" || run.status === "error" || run.status === "needs") return run.status;
  return "working";
}

export function Island({
  model,
  actions,
}: {
  model: OrbViewModel;
  actions: OrbViewActions;
}): ReactElement {
  const state = islandState(model);
  return (
    <div className="island" data-state={state}>
      <IslandBody state={state} model={model} actions={actions} />
    </div>
  );
}

function IslandBody({
  state,
  model,
  actions,
}: {
  state: IslandState;
  model: OrbViewModel;
  actions: OrbViewActions;
}): ReactElement {
  const run = model.run as OrbRun;
  if (state === "compose") return <Compose model={model} actions={actions} />;
  if (state === "working") return <Working model={model} run={run} actions={actions} />;
  if (state === "paused") return <Paused actions={actions} />;
  if (state === "needs")
    return (
      <ApprovalCard
        title={run.dialog?.title || "Aeon needs you"}
        message={run.dialog?.message ?? "Take a look at the highlighted part of the page."}
        count={model.needsCount}
      >
        <div className="run-actions">
          <Button kind="primary" onClick={actions.openChat}>
            Answer in chat
          </Button>
        </div>
      </ApprovalCard>
    );
  if (state === "error")
    return (
      <ResultCard tone="failed" answer={run.error ?? "The run failed."}>
        <Button kind="primary" onClick={actions.again}>
          Try again
        </Button>
        <Button onClick={actions.openChat}>Open chat</Button>
      </ResultCard>
    );
  return <Done model={model} run={run} actions={actions} />;
}

function Compose({
  model,
  actions,
}: {
  model: OrbViewModel;
  actions: OrbViewActions;
}): ReactElement {
  const send = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const text = event.currentTarget.value.trim();
    if (text) actions.submit(text);
  };
  return (
    <>
      <div className="isl-row">
        <span className="isl-orb" aria-hidden="true" />
        <textarea
          id="prompt"
          rows={1}
          placeholder="Ask Aeon to do something on this page…"
          aria-label="Ask Aeon"
          disabled={model.busy}
          onKeyDown={send}
        />
        <Button kind="icon" label="Close (Esc)" onClick={actions.close}>
          ✕
        </Button>
      </div>
      <div className="isl-hint" data-warn={String(Boolean(model.notice))}>
        <span>{model.notice || "Enter to send · Esc to close"}</span>
        <span className="isl-chip">{model.host || "This page"}</span>
      </div>
    </>
  );
}

function Working({
  model,
  run,
  actions,
}: {
  model: OrbViewModel;
  run: OrbRun;
  actions: OrbViewActions;
}): ReactElement {
  return (
    <>
      <div className="isl-row">
        <button
          type="button"
          className="isl-main"
          aria-expanded={model.expanded}
          title={model.expanded ? "Hide steps" : "Show steps"}
          onClick={actions.toggleDetails}
        >
          <span className="isl-orb" data-live="true" aria-hidden="true" />
          <span className="isl-text">
            <span className="isl-live">{run.label}</span>
            <span className="isl-detail">{stepLine(run, model.host)}</span>
          </span>
        </button>
        <Button kind="icon" label="Take over" onClick={actions.takeOver}>
          ✋
        </Button>
        <Button kind="icon" label="Stop" onClick={actions.stop}>
          ■
        </Button>
        <Button kind="icon" label="Open chat" onClick={actions.openChat}>
          ↗
        </Button>
      </div>
      {model.expanded && <StepTimeline steps={run.steps} />}
      <ProgressLine progress={currentProgress(run)} />
    </>
  );
}

/**
 * "Step 3 · kayak.com · site API": where the run is, and the last path it took. A long job inside
 * the current step shows its count instead: "Removing 47/77 · youtube.com".
 */
export function stepLine(run: OrbRun, host: string): string {
  const count = run.steps.length;
  const last = [...run.steps].reverse().find((step) => step.done && step.path);
  const job = currentProgress(run);
  if (job) return [formatProgress(job), host].filter(Boolean).join(" · ");
  return [count ? `Step ${count}` : "Starting", host, last?.path ? PATH_NAMES[last.path] : ""]
    .filter(Boolean)
    .join(" · ");
}

function currentProgress(run: OrbRun): RunProgress | undefined {
  const step = run.steps.at(-1);
  return step && !step.done ? step.progress : undefined;
}

/** Endless while the count is unknown; fills up as a job with a known total goes. */
function ProgressLine({ progress }: { progress: RunProgress | undefined }): ReactElement {
  const share =
    progress?.total !== undefined && progress.total > 0
      ? Math.min(1, progress.done / progress.total)
      : undefined;
  return share === undefined ? (
    <div className="isl-progress" aria-hidden="true" />
  ) : (
    <div
      className="isl-progress"
      data-determinate="true"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={progress?.total}
      aria-valuenow={progress?.done}
      style={{ "--isl-progress": share } as CSSProperties}
    />
  );
}

function Paused({ actions }: { actions: OrbViewActions }): ReactElement {
  return (
    <div className="isl-row">
      <span className="isl-orb" data-paused="true" aria-hidden="true" />
      <span className="isl-text">
        <span className="isl-live">Paused, you&rsquo;re driving</span>
        <span className="isl-detail">Aeon stopped so you can use the page.</span>
      </span>
      <Button kind="primary" onClick={actions.resume}>
        Resume
      </Button>
      <Button kind="icon" label="Open chat" onClick={actions.openChat}>
        ↗
      </Button>
    </div>
  );
}

function Done({
  model,
  run,
  actions,
}: {
  model: OrbViewModel;
  run: OrbRun;
  actions: OrbViewActions;
}): ReactElement {
  const plan = watchPlan(run);
  const saved = model.watch.state === "saved";
  return (
    <ResultCard
      answer={run.answer || "Finished."}
      summary={summarize(run)}
      note={plan.kind === "none" ? plan.reason : model.watch.note}
    >
      <Button kind="primary" onClick={actions.again}>
        Run again
      </Button>
      {plan.kind !== "none" && (
        <Button
          label="Check this again every 15 minutes and tell me when it changes"
          disabled={saved || model.watch.state === "saving"}
          onClick={actions.watch}
        >
          {saved ? "Watching ✓" : "Watch"}
        </Button>
      )}
      <Button onClick={actions.openChat}>Open chat</Button>
      <Button kind="icon" label="Close (Esc)" onClick={actions.close}>
        ✕
      </Button>
    </ResultCard>
  );
}

function Button({
  kind = "ghost",
  label,
  disabled = false,
  onClick,
  children,
}: {
  kind?: "primary" | "ghost" | "icon";
  label?: string;
  disabled?: boolean;
  onClick(): void;
  children: string;
}): ReactElement {
  return (
    <button
      type="button"
      className={kind}
      title={label}
      aria-label={kind === "icon" ? label : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

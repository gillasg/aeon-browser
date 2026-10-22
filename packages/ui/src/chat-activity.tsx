import { FileLink } from "./file-links.js";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ToolGroup, ToolStep } from "./transcript-model.js";
import {
  describeToolAction,
  describeToolGroup,
  isShellTool,
  toolKind,
} from "./chat-activity-summary.js";
import { projectEditDiff, ToolEditDiff } from "./tool-edit-diff.js";
import { ActivityIcon, DisclosureChevron } from "./activity-icons.js";
import { BrowserCallRows, browserActionValues } from "./activity-browser-call.js";
import { ShellToolDetails, CodeToolDetails, ToolStepFooter } from "./activity-tool-details.js";
import { ToolResultView } from "./tool-result-view.js";
import { ToolImages } from "./tool-images.js";
import { StepMeta } from "./run-cards.js";
import { formatProgress } from "./run-model.js";

export function ChatActivityGroup({
  group,
  aggregateOnly = false,
  streaming = false,
  children,
}: {
  group: ToolGroup;
  aggregateOnly?: boolean;
  streaming?: boolean;
  children?: ReactNode;
}): ReactElement | null {
  const activityDetails = useRef<HTMLDetailsElement>(null);
  const initialized = useRef(false);
  const active = latestRunningStep(group);
  const now = useActivityClock(Boolean(active));
  useLayoutEffect(() => {
    if (!active && !streaming && activityDetails.current) activityDetails.current.open = false;
    if (!initialized.current && active && activityDetails.current)
      activityDetails.current.open = true;
    initialized.current = true;
  }, [Boolean(active), streaming]);

  if (!group.steps.length) return null;
  const action = latestAction(group, active);
  if (!action) return null;
  const failed = group.steps.some((step) => step.isError);
  const pending = group.steps.some((step) => step.state === "pending");
  const elapsed = groupElapsed(group, active, now);
  const content = (
    <ActivityBundle
      group={group}
      active={active}
      action={action}
      failed={failed}
      pending={pending}
      children={children}
      streaming={streaming}
    />
  );
  if (aggregateOnly) return <div className="activity-group">{content}</div>;
  return (
    <div className="activity-group">
      <details
        ref={activityDetails}
        className="activity-card"
        data-running={String(Boolean(active))}
        data-pending={String(pending)}
        data-failed={String(failed)}
      >
        <summary>
          <span className="activity-duration">
            {active ? "Working" : pending ? "Pending" : "Worked"} for {formatDuration(elapsed)}
          </span>
          <DisclosureChevron />
        </summary>
        {content}
      </details>
    </div>
  );
}

function ToolStepRow({
  step,
  group,
  ancestors,
}: {
  step: ToolStep;
  group: ToolGroup;
  ancestors: ReadonlySet<string>;
}): ReactElement {
  const browserActions = browserActionValues(
    step.arguments,
    step.toolName === "browser_code" ? step.result || step.partialResult : undefined,
  );
  if (browserActions.length > 0) return <BrowserCallRows step={step} actions={browserActions} />;
  const nextAncestors = new Set(ancestors).add(step.toolCallId);
  const children = group.steps.filter(
    (candidate) =>
      candidate.parentToolCallId === step.toolCallId && !nextAncestors.has(candidate.toolCallId),
  );
  const label = toolStateLabel(step);
  return (
    <details
      className="activity-step"
      data-tool-call-id={step.toolCallId}
      data-state={step.state}
      data-failed={String(step.isError)}
    >
      <summary>
        <ActivityIcon toolName={step.toolName} />
        <span className="activity-step-name">
          <ToolActionLabel step={step} />
        </span>
        {step.state !== "running" && (
          <StepMeta path={step.path} durationMs={step.durationMs ?? measured(step)} />
        )}
        {step.state === "running" && step.progress && (
          <span className="run-step-meta">{formatProgress(step.progress)}</span>
        )}
        {label && (
          <span className={`activity-state-badge ${step.isError ? "is-error" : "is-running"}`}>
            {label}
          </span>
        )}
        <DisclosureChevron />
      </summary>
      <ToolBody step={step} />
      <ToolImages step={step} />
      {step.nestedCalls?.complete === false && (
        <p className="activity-incomplete">Some nested call details were not retained.</p>
      )}
      <NestedCalls step={step} group={group} children={children} ancestors={nextAncestors} />
      <ToolStepFooter step={step} />
    </details>
  );
}

function NestedCalls({
  step,
  group,
  children,
  ancestors,
}: {
  step: ToolStep;
  group: ToolGroup;
  children: readonly ToolStep[];
  ancestors: ReadonlySet<string>;
}): ReactElement | null {
  if (!children.length) return null;
  return (
    <section className="activity-nested" aria-label={`Nested calls for ${step.toolName}`}>
      <p className="activity-nested-heading">Nested calls</p>
      <div className="activity-steps">
        {children.map((child) => (
          <ToolStepRow key={child.key} step={child} group={group} ancestors={ancestors} />
        ))}
      </div>
    </section>
  );
}

function rootSteps(group: ToolGroup): ToolStep[] {
  const ids = new Set(group.steps.map((step) => step.toolCallId));
  const roots = group.steps.filter(
    (step) => !step.parentToolCallId || !ids.has(step.parentToolCallId),
  );
  return roots.length ? roots : group.steps.slice(0, 1);
}

function latestAction(group: ToolGroup, active: ToolStep | undefined): ToolStep | undefined {
  if (active) return active;
  const parentIds = new Set(group.steps.map((step) => step.parentToolCallId));
  const leaves = group.steps.filter((step) => !parentIds.has(step.toolCallId));
  return [...(leaves.length ? leaves : group.steps)].sort(
    (left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0),
  )[0];
}

function groupElapsed(group: ToolGroup, active: ToolStep | undefined, now: number): number {
  const start = Math.min(...group.steps.map((step) => step.startedAt));
  const end = active
    ? now
    : Math.max(...group.steps.map((step) => step.endedAt ?? step.lastActivityAt ?? step.startedAt));
  return Math.max(0, Math.floor((end - start) / 1000));
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining ? `${minutes}m ${remaining}s` : `${minutes}m`;
}

function toolStateLabel(step: ToolStep): string {
  if (step.isError || step.state === "failed") return "Error";
  return "";
}

function ToolActionLabel({ step }: { step: ToolStep }): ReactElement {
  const diff = projectEditDiff(step);
  const description = describeToolAction(step);
  const path = ["path", "filePath", "file_path", "file", "filename"]
    .map((key) => step.arguments[key])
    .find((value): value is string => typeof value === "string");
  if (!path || toolKind(step.toolName) !== "file") return <>{description}</>;
  const filename = path.replaceAll("\\", "/").split("/").at(-1) ?? path;
  const prefix = description.endsWith(filename)
    ? description.slice(0, -filename.length)
    : description + " ";
  return (
    <>
      {prefix}
      <span className="activity-filename">
        <FileLink path={path}>{filename}</FileLink>
      </span>
      {diff?.confirmed && !diff.truncated && (
        <span className="inline-edit-count" title="Counts from Pi's change diff">
          <span className="diff-count-added">+{diff.added}</span>
          <span className="diff-count-removed">−{diff.removed}</span>
        </span>
      )}
    </>
  );
}

function ToolBody({ step }: { step: ToolStep }): ReactElement {
  const editPreview = projectEditDiff(step);
  return (
    <>
      {isShellTool(step.toolName) && <ShellToolDetails step={step} />}
      {toolKind(step.toolName) === "code" && <CodeToolDetails step={step} />}
      {editPreview && <ToolEditDiff step={step} />}
      {!isShellTool(step.toolName) && toolKind(step.toolName) !== "code" && !editPreview && (
        <ToolResultView step={step} compact />
      )}
      {editPreview && step.isError && <ToolResultView step={step} compact />}
    </>
  );
}

function ActivityBundle({
  streaming = false,
  group,
  active,
  action,
  failed,
  pending,
  children,
}: {
  group: ToolGroup;
  active: ToolStep | undefined;
  action: ToolStep;
  failed: boolean;
  pending: boolean;
  children?: ReactNode;
  streaming?: boolean;
}): ReactElement {
  const bundle = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (bundle.current) bundle.current.open = streaming;
  }, [streaming, group.steps.length]);
  const summaryIcon = group.steps.find((step) => /edit|write/i.test(step.toolName)) ?? action;
  const roots = rootSteps(group);
  const showSummary = roots.length > 1;
  const content = (
    <>
      {" "}
      {!showSummary && (
        <>
          {children}
          {roots.map((step) => (
            <ToolStepRow key={step.key} step={step} group={group} ancestors={new Set()} />
          ))}
        </>
      )}
      {showSummary && (
        <details ref={bundle} className="activity-bundle" data-failed={String(failed)}>
          <summary>
            <ActivityIcon toolName={summaryIcon.toolName} />
            <span className="activity-bundle-label">{describeToolGroup(group)}</span>
            {pending && !active && <span className="activity-state-badge">Pending</span>}
            <DisclosureChevron />
          </summary>
          <div className="activity-steps">
            {children}
            {roots.map((step) => (
              <ToolStepRow key={step.key} step={step} group={group} ancestors={new Set()} />
            ))}
          </div>
        </details>
      )}
    </>
  );
  return content;
}

function latestRunningStep(group: ToolGroup): ToolStep | undefined {
  return group.steps
    .filter((step) => step.state === "running")
    .sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0))[0];
}

function useActivityClock(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function measured(step: ToolStep): number | undefined {
  return step.endedAt === undefined ? undefined : Math.max(0, step.endedAt - step.startedAt);
}

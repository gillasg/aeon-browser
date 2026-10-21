import type { ReactElement, ReactNode } from "react";
import { PATH_NAMES, formatRunDuration, type RunPath, type RunStep } from "./run-model.js";

// The three run parts every surface shares: the orb's island, the side panel and the chat
// transcript. Same markup everywhere; each surface skins the `run-*` classes.

/** Which fast path a step took. Dashed when the path was guessed from the tool name. */
export function PathTag({
  path,
  mocked = false,
}: {
  path: RunPath | undefined;
  mocked?: boolean | undefined;
}): ReactElement | null {
  if (!path) return null;
  return (
    <span
      className="run-path"
      data-path={path}
      data-mocked={String(mocked)}
      title={mocked ? "Guessed from the tool" : "Reported by the tool"}
    >
      {PATH_NAMES[path]}
    </span>
  );
}

/** Path and time for one finished step, shown at the end of a step row. */
export function StepMeta({
  path,
  pathMocked,
  durationMs,
}: {
  path?: RunPath | undefined;
  pathMocked?: boolean | undefined;
  durationMs?: number | undefined;
}): ReactElement | null {
  if (!path && durationMs === undefined) return null;
  return (
    <span className="run-step-meta">
      <PathTag path={path} mocked={pathMocked} />
      {durationMs !== undefined && (
        <span className="run-duration">{formatRunDuration(durationMs)}</span>
      )}
    </span>
  );
}

export function StepTimeline({
  steps,
  limit = 8,
}: {
  steps: readonly RunStep[];
  limit?: number;
}): ReactElement | null {
  if (!steps.length) return null;
  const shown = steps.slice(-limit);
  const hidden = steps.length - shown.length;
  return (
    <ol className="run-timeline" aria-label="Steps">
      {hidden > 0 && <li className="run-step run-step-more">{hidden} earlier steps</li>}
      {shown.map((step) => (
        <li
          key={step.toolCallId}
          className="run-step"
          data-state={step.isError ? "failed" : step.done ? "done" : "running"}
        >
          <span className="run-step-dot" aria-hidden="true" />
          <span className="run-step-label">{step.label}</span>
          <StepMeta path={step.path} pathMocked={step.pathMocked} durationMs={step.durationMs} />
        </li>
      ))}
    </ol>
  );
}

export function ApprovalCard({
  title,
  message,
  count,
  children,
}: {
  title: string;
  message?: string | null | undefined;
  /** How many things are waiting for the user, this one included. */
  count?: number | undefined;
  children?: ReactNode;
}): ReactElement {
  return (
    <section className="run-approval" aria-label={`Needs you: ${title}`}>
      <header>
        <span className="run-needs-dot" aria-hidden="true" />
        <span className="run-eyebrow">Needs you</span>
        {count !== undefined && count > 1 && (
          <span className="run-count" aria-label={`${count} waiting`}>
            {count}
          </span>
        )}
      </header>
      <h2>{title}</h2>
      {message && <p>{message}</p>}
      {children}
    </section>
  );
}

export function ResultCard({
  tone = "done",
  title,
  answer,
  summary,
  note,
  children,
}: {
  tone?: "done" | "failed";
  title?: string;
  answer: string;
  summary?: string;
  /** One line under the actions: why Watch is missing, or what it did. */
  note?: string;
  children?: ReactNode;
}): ReactElement {
  return (
    <section className="run-result" data-tone={tone}>
      <header className="run-eyebrow">
        {title ?? (tone === "done" ? "Done" : "Something went wrong")}
      </header>
      <div className="run-answer">{answer}</div>
      {summary && <div className="run-summary">{summary}</div>}
      {children && <div className="run-actions">{children}</div>}
      {note && <p className="run-note">{note}</p>}
    </section>
  );
}

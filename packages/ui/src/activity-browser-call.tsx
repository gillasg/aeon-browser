import type { ReactElement } from "react";
import type { ToolStep } from "./transcript-model.js";
import { describeBrowserOperation } from "./tool-action-labels.js";
import { ActivityIcon, DisclosureChevron } from "./activity-icons.js";
import { ToolStepFooter } from "./activity-tool-details.js";
import { ToolResultView } from "./tool-result-view.js";
import { ToolImages } from "./tool-images.js";
export function BrowserCallRows({
  step,
  actions,
}: {
  step: ToolStep;
  actions: readonly Record<string, unknown>[];
}): ReactElement {
  const outcomes = browserOperationOutcomes(step.result || step.partialResult);
  const hasFailedOperation = [...outcomes.values()].some(
    (outcome) => outcome.disposition === "failed",
  );
  return (
    <section className="activity-browser-call" data-tool-call-id={step.toolCallId}>
      {step.isError && !hasFailedOperation && (
        <div className="activity-browser-call-error" role="status">
          <span className="activity-state-badge is-error">Error</span>
          <span>Browser call failed; expand its result for the exact details.</span>
        </div>
      )}
      <ol className="activity-browser-action-rows">
        {actions.map((action, index) => (
          <BrowserOperationRow
            key={`${step.toolCallId}:${index}`}
            step={step}
            action={action}
            outcome={outcomes.get(index)}
            unmappedFailure={
              step.isError && !hasFailedOperation && actions.length === 1 && !outcomes.has(index)
            }
            showImages={
              index ===
              actions.findIndex((item) => item.op === "observe" && item.kind === "screenshot")
            }
          />
        ))}
      </ol>
      <ToolStepFooter step={step} />
    </section>
  );
}

function browserOperationDetails(action: Record<string, unknown>): string | undefined {
  const operation = stringValue(action, "op");
  if (operation === "scroll") {
    const direction = stringValue(action, "direction");
    const amount = typeof action.amount === "number" ? `${action.amount} px` : undefined;
    return [direction && `Scroll ${direction}`, amount].filter(Boolean).join(" · ");
  }
  if (operation === "observe")
    return action.kind === "screenshot" ? "Screenshot observation" : "Page observation";
  if (operation === "openTab") return stringValue(action, "url");
  if (operation === "listTabs") return stringValue(action, "query");
  if (operation === "fill" && isRecord(action.element))
    return stringValue(action.element, "name", "role");
  if (operation === "click" && isRecord(action.element))
    return stringValue(action.element, "name", "role");
  return undefined;
}

function browserActionIconName(action: Record<string, unknown>): string {
  const operation = stringValue(action, "op", "action", "operation", "type") ?? "";
  if (/search|history/i.test(operation)) return operation;
  if (/scroll|click|fill|type|press|select/i.test(operation)) return "code";
  return "browser_control";
}

export function browserActionValues(
  arguments_: Record<string, unknown>,
  result?: string,
): Record<string, unknown>[] {
  const value = arguments_.steps ?? arguments_.actions ?? workflowActions(result);
  if (!Array.isArray(value)) return [];
  return value.filter(
    (action): action is Record<string, unknown> =>
      typeof action === "object" && action !== null && !Array.isArray(action),
  );
}

function workflowActions(result?: string): unknown {
  if (!result) return [];
  try {
    const imageMarker = result.lastIndexOf("Image output · ");
    const parsed: unknown = JSON.parse(
      imageMarker < 0 ? result : result.slice(0, imageMarker).trimEnd(),
    );
    return isRecord(parsed) && Array.isArray(parsed.steps)
      ? parsed.steps.map((entry: unknown) => (isRecord(entry) ? entry.action : undefined))
      : [];
  } catch {
    return [];
  }
}

function browserOperationOutcomes(
  value: string,
): Map<number, { disposition: string; code?: string; result?: unknown }> {
  try {
    const imageMarker = value.lastIndexOf("Image output · ");
    const resultText = imageMarker < 0 ? value : value.slice(0, imageMarker).trimEnd();
    const parsed: unknown = JSON.parse(resultText);
    if (!isRecord(parsed) || !Array.isArray(parsed.steps)) return new Map();
    const outcomes = new Map<number, { disposition: string; code?: string; result?: unknown }>();
    for (const item of parsed.steps) {
      if (!isRecord(item) || typeof item.index !== "number") continue;
      if (typeof item.disposition !== "string") continue;
      outcomes.set(item.index, {
        disposition: item.disposition,
        ...(typeof item.code === "string" ? { code: item.code } : {}),
        ...(item.result !== undefined ? { result: item.result } : {}),
      });
    }
    return outcomes;
  } catch {
    return new Map();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringValue(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof source[key] === "string") return source[key] as string;
  return undefined;
}

function BrowserOperationRow({
  step,
  action,
  outcome,
  unmappedFailure,
  showImages,
}: {
  step: ToolStep;
  action: Record<string, unknown>;
  outcome: BrowserOutcome | undefined;
  unmappedFailure: boolean;
  showImages: boolean;
}): ReactElement {
  const { failed, state, resultStep } = operationProjection(step, outcome, unmappedFailure);
  return (
    <li>
      <details className="activity-step" data-state={state} data-failed={String(failed)}>
        <summary>
          <ActivityIcon toolName={browserActionIconName(action)} />
          <span className="activity-step-name">
            {describeBrowserOperation(action, outcome?.result)}
          </span>
          {(failed || outcome?.disposition === "skipped") && (
            <span className={`activity-state-badge ${failed ? "is-error" : ""}`}>
              {failed ? "Error" : "Skipped"}
            </span>
          )}
          <DisclosureChevron />
        </summary>
        <BrowserOperationDetails
          action={action}
          step={step}
          outcome={outcome}
          resultStep={resultStep}
        />
      </details>
      {showImages && <ToolImages step={step} />}
    </li>
  );
}

type BrowserOutcome = { disposition: string; code?: string; result?: unknown };

function operationProjection(
  step: ToolStep,
  outcome: BrowserOutcome | undefined,
  unmappedFailure: boolean,
): { failed: boolean; state: string; resultStep: ToolStep | undefined } {
  const failed = outcome?.disposition === "failed" || unmappedFailure;
  const state = failed
    ? "failed"
    : outcome?.disposition === "completed"
      ? "complete"
      : outcome?.disposition === "skipped"
        ? "skipped"
        : step.state;
  const operationResult = operationResultValue(outcome);
  const resultStep =
    operationResult === undefined
      ? undefined
      : {
          ...step,
          result:
            typeof operationResult === "string"
              ? operationResult
              : JSON.stringify(operationResult, null, 2),
          partialResult: "",
          isError: failed,
          resultUnavailable: false,
          state: failed ? ("failed" as const) : ("complete" as const),
        };
  return { failed, state, resultStep };
}

function BrowserOperationDetails({
  action,
  step,
  outcome,
  resultStep,
}: {
  action: Record<string, unknown>;
  step: ToolStep;
  outcome: BrowserOutcome | undefined;
  resultStep: ToolStep | undefined;
}): ReactElement {
  const detail = browserOperationDetails(action);
  return (
    <div className="activity-operation-body">
      {detail && <p className="activity-operation-detail">{detail}</p>}
      {resultStep && <ToolResultView step={resultStep} compact />}
      <OperationDispositionNote outcome={outcome} step={step} hasResult={Boolean(resultStep)} />
      <details className="activity-raw-details">
        <summary>Raw operation data</summary>
        <pre className="step-detail">{JSON.stringify(action, null, 2)}</pre>
      </details>
    </div>
  );
}

function OperationDispositionNote({
  outcome,
  step,
  hasResult,
}: {
  outcome: BrowserOutcome | undefined;
  step: ToolStep;
  hasResult: boolean;
}): ReactElement | null {
  if (hasResult) return null;
  if (outcome?.disposition === "completed") {
    return (
      <p className="activity-result-note">
        Pi completed this browser operation without retaining a result body.
      </p>
    );
  }
  if (outcome?.disposition === "failed") {
    return (
      <p className="activity-result-note">Pi did not retain details for this failed operation.</p>
    );
  }
  if (outcome?.disposition === "skipped") {
    return (
      <p className="activity-result-note">Pi skipped this operation after an earlier error.</p>
    );
  }
  if (!outcome && step.state === "complete") {
    return (
      <p className="activity-result-note">
        Pi completed the browser call without retaining a result for this operation.
      </p>
    );
  }
  return null;
}

function operationResultValue(outcome: BrowserOutcome | undefined): unknown {
  return outcome?.result ?? outcome?.code;
}

import { useState, type ReactElement } from "react";
import type { ToolStep } from "./transcript-model.js";
import { copyTextToClipboard } from "./clipboard.js";
export function ShellToolDetails({ step }: { step: ToolStep }): ReactElement {
  const command = stringValue(step.arguments, "command", "cmd");
  const output = step.result || step.partialResult;
  return (
    <div className="activity-shell-output" aria-label="Shell command and output">
      {command && <pre className="activity-shell-command">$ {command}</pre>}
      {output && <pre className="activity-shell-result">{output}</pre>}
    </div>
  );
}

export function CodeToolDetails({ step }: { step: ToolStep }): ReactElement {
  const code = stringValue(step.arguments, "code", "source");
  const output = step.result || step.partialResult;
  return (
    <div className="activity-code-output" aria-label="Code and tool result">
      {code && <pre className="activity-code-source">{code}</pre>}
      {output && <pre className="activity-code-result">{output}</pre>}
    </div>
  );
}

export function RawToolData({ step }: { step: ToolStep }): ReactElement | null {
  const hasInput = Object.keys(step.arguments).length > 0 || Boolean(step.argumentsBytes);
  if (!hasInput && !step.result && !step.partialResult) return null;
  return (
    <details className="activity-raw-details">
      <summary>Raw tool data</summary>
      <RawToolDataContent step={step} />
    </details>
  );
}

export function RawToolDataContent({ step }: { step: ToolStep }): ReactElement {
  const argumentsValue =
    Object.keys(step.arguments).length > 0
      ? JSON.stringify(step.arguments, null, 2)
      : step.argumentsBytes
        ? `Arguments were not retained · ${step.argumentsBytes} bytes`
        : "";
  const output = step.result || step.partialResult;
  return (
    <>
      <p className="activity-source-name">
        {step.toolName} · {step.toolCallId}
      </p>
      {argumentsValue && <StepDetail label="Arguments" value={argumentsValue} />}
      {output && <StepDetail label="Output" value={output} />}
      {step.resultUnavailable && (
        <p className="activity-result-note">Pi did not retain this result body.</p>
      )}
    </>
  );
}

export function ToolStepFooter({ step }: { step: ToolStep }): ReactElement | null {
  const [copyState, setCopyState] = useState<"Copy output" | "Copied" | "Copy failed">(
    "Copy output",
  );
  if (/^(read|read_file|readfile|write|write_file|edit|edit_file)$/i.test(step.toolName))
    return null;
  const output = step.result || step.partialResult;
  const timestamp = step.endedAt ?? step.lastActivityAt ?? step.startedAt;
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.valueOf())) return null;
  const label = step.endedAt ? "Completed" : "Updated";
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    date,
  );
  const fullTime = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
  const copy = async (): Promise<void> => {
    try {
      await copyTextToClipboard(output);
      setCopyState("Copied");
    } catch {
      setCopyState("Copy failed");
    }
  };
  return (
    <div className="tool-step-footer">
      {output && (
        <button
          type="button"
          className="tool-step-copy"
          aria-label="Copy tool output"
          title={copyState}
          onClick={() => void copy()}
        >
          {copyState}
        </button>
      )}
      <time dateTime={date.toISOString()} title={fullTime}>
        {label} · {time}
      </time>
    </div>
  );
}

function StepDetail({
  label,
  value,
  className = "step-detail",
}: {
  label: string;
  value: string;
  className?: string;
}): ReactElement | null {
  return value ? (
    <>
      <p className="step-detail-label">{label}</p>
      <pre className={className}>{value}</pre>
    </>
  ) : null;
}

function stringValue(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof source[key] === "string") return source[key] as string;
  return undefined;
}

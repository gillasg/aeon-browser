import { OpenDiffButton } from "./open-diff-button.js";
import { FileLink } from "./file-links.js";
import { useState, type ReactElement } from "react";
import type { ToolStep } from "./transcript-model.js";
import { copyTextToClipboard } from "./clipboard.js";

type DiffRow = {
  kind: "context" | "added" | "removed" | "gap";
  oldLine?: number;
  newLine?: number;
  text: string;
};

interface EditDiff {
  path: string;
  rows: DiffRow[];
  added: number;
  removed: number;
  truncated: boolean;
  noChanges: boolean;
  confirmed: boolean;
}

export function projectEditDiff(step: ToolStep): EditDiff | undefined {
  const name = step.toolName.toLowerCase();
  if (!/(?:^|[^a-z0-9])(?:edit|write)(?:$|[^a-z0-9])/.test(name)) return undefined;
  if (step.changeDiff !== undefined) return nativeDiff(step);
  const oldText = stringValue(step.arguments, "oldText", "old_text");
  const newText = stringValue(step.arguments, "newText", "new_text", "content");
  if (oldText === undefined && newText === undefined) return undefined;
  const oldLines = boundedLines(oldText ?? "");
  const newLines = boundedLines(newText ?? "");
  const truncated = oldLines.truncated || newLines.truncated;
  const rows =
    oldText === undefined ? addedRows(newLines.lines) : focusedDiff(oldLines.lines, newLines.lines);
  if (truncated) rows.push({ kind: "gap", text: "Preview truncated" });
  return {
    confirmed: isCompletedFileChange(step),
    path: stringValue(step.arguments, "path", "filePath", "file_path", "file") ?? "File",
    rows,
    added: rows.filter((row) => row.kind === "added").length,
    removed: rows.filter((row) => row.kind === "removed").length,
    truncated,
    noChanges: noChanges(oldText, truncated, rows),
  };
}

export function ToolEditDiff({ step }: { step: ToolStep }): ReactElement | null {
  const [copied, setCopied] = useState(false);
  const diff = projectEditDiff(step);
  if (!diff) return null;
  const preview = diff.rows
    .map((row) => `${row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "}${row.text}`)
    .join("\n");
  const copy = async (): Promise<void> => {
    try {
      await copyTextToClipboard(preview);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section
      className="inline-edit-diff"
      aria-label="File change preview"
      title={diff.confirmed ? "Pi confirmed changes" : "Preview from tool arguments"}
    >
      <header className="inline-edit-header">
        <div className="inline-edit-path" title={diff.path}>
          <FileLink path={diff.path} />
        </div>
        {diff.confirmed && (
          <span
            className="inline-edit-count"
            aria-label={`${diff.added} added, ${diff.removed} removed`}
          >
            <span className="diff-count-added">+{diff.added}</span>
            <span className="diff-count-removed">−{diff.removed}</span>
          </span>
        )}
        <OpenDiffButton diff={diff} />

        <button
          type="button"
          className="inline-edit-copy"
          aria-label="Copy file change preview"
          title={copied ? "Copied" : "Copy preview"}
          onClick={() => void copy()}
        >
          {copied ? "✓" : <CopyIcon />}
        </button>
      </header>
      {!diff.confirmed && <ProposedChangesNote />}
      <div className="inline-edit-lines" aria-label="Changed lines">
        {diff.noChanges ? (
          <p className="diff-empty">No changed lines in the supplied text.</p>
        ) : (
          diff.rows.map((row, index) => <DiffLine key={`${row.kind}:${index}`} row={row} />)
        )}
      </div>
    </section>
  );
}

function DiffLine({ row }: { row: DiffRow }): ReactElement {
  if (row.kind === "gap") return <p className="diff-gap">… {row.text} …</p>;
  const number = row.kind === "removed" ? row.oldLine : (row.newLine ?? row.oldLine);
  return (
    <pre className={`diff-line diff-${row.kind}`}>
      <span className="diff-number" aria-hidden="true">
        {number ?? ""}
      </span>
      <span className="diff-marker" aria-hidden="true">
        {row.kind === "added" ? "+" : row.kind === "removed" ? "−" : ""}
      </span>
      <code>{row.text}</code>
    </pre>
  );
}

function CopyIcon(): ReactElement {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="7" y="6" width="9" height="11" rx="1.5" />
      <path d="M13 6V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v9A1.5 1.5 0 0 0 4.5 15H7" />
    </svg>
  );
}

function focusedDiff(oldLines: readonly string[], newLines: readonly string[]): DiffRow[] {
  const operations = lineDiff(oldLines, newLines);
  const changed = operations.flatMap((row, index) => (row.kind === "context" ? [] : [index]));
  if (!changed.length) return [];
  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - 2);
    const end = Math.min(operations.length - 1, index + 2);
    const previous = ranges.at(-1);
    if (previous && start <= previous[1] + 1) previous[1] = end;
    else ranges.push([start, end]);
  }
  const visible: DiffRow[] = [];
  ranges.forEach(([start, end], rangeIndex) => {
    if (rangeIndex > 0) visible.push({ kind: "gap", text: "unchanged lines" });
    visible.push(...operations.slice(start, end + 1));
  });
  return visible;
}

function lineDiff(oldLines: readonly string[], newLines: readonly string[]): DiffRow[] {
  const columns = newLines.length + 1;
  const lengths = diffLengths(oldLines, newLines);
  const rows: DiffRow[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (sameLine(oldLines, newLines, oldIndex, newIndex)) {
      rows.push({
        kind: "context",
        oldLine: oldIndex + 1,
        newLine: newIndex + 1,
        text: oldLines[oldIndex] ?? "",
      });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      oldIndex < oldLines.length &&
      (newIndex >= newLines.length ||
        (lengths[(oldIndex + 1) * columns + newIndex] ?? 0) >=
          (lengths[oldIndex * columns + newIndex + 1] ?? 0))
    ) {
      rows.push({ kind: "removed", oldLine: oldIndex + 1, text: oldLines[oldIndex] ?? "" });
      oldIndex += 1;
    } else {
      rows.push({ kind: "added", newLine: newIndex + 1, text: newLines[newIndex] ?? "" });
      newIndex += 1;
    }
  }
  return rows;
}

function addedRows(lines: readonly string[]): DiffRow[] {
  return lines.map((text, index) => ({ kind: "added", newLine: index + 1, text }));
}

function stringValue(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof source[key] === "string") return source[key] as string;
  return undefined;
}

function boundedLines(value: string): { lines: string[]; truncated: boolean } {
  if (!value) return { lines: [], truncated: false };
  const lines = value.slice(0, 8000).split(/\r?\n/);
  if (value.endsWith("\n") || value.endsWith("\r")) lines.pop();
  const truncated = value.length > 8000 || lines.length > 80;
  return { lines: lines.slice(0, 80).map((line) => line.slice(0, 300)), truncated };
}

function nativeDiff(step: ToolStep): EditDiff {
  const rows: DiffRow[] = (step.changeDiff ?? "").split(/\r?\n/).flatMap<DiffRow>((line) => {
    const match = /^([+\- ])\s*(\d+) (.*)$/.exec(line);
    if (!match) return line.trim() ? [{ kind: "gap" as const, text: line.trim() }] : [];
    const number = Number(match[2]);
    const kind = match[1] === "+" ? "added" : match[1] === "-" ? "removed" : "context";
    return [
      {
        kind,
        text: match[3] ?? "",
        ...(kind === "removed" ? { oldLine: number } : { newLine: number }),
      },
    ];
  });
  return {
    path: stringValue(step.arguments, "path", "filePath", "file_path", "file") ?? "File",
    rows,
    added: rows.filter((x) => x.kind === "added").length,
    removed: rows.filter((x) => x.kind === "removed").length,
    truncated: false,
    noChanges: rows.length === 0,
    confirmed: true,
  };
}

function diffLengths(oldLines: readonly string[], newLines: readonly string[]): Uint8Array {
  const columns = newLines.length + 1;
  const lengths = new Uint8Array((oldLines.length + 1) * columns);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const at = oldIndex * columns + newIndex;
      lengths[at] =
        oldLines[oldIndex] === newLines[newIndex]
          ? 1 + (lengths[(oldIndex + 1) * columns + newIndex + 1] ?? 0)
          : Math.max(
              lengths[(oldIndex + 1) * columns + newIndex] ?? 0,
              lengths[oldIndex * columns + newIndex + 1] ?? 0,
            );
    }
  }
  return lengths;
}

function sameLine(
  oldLines: readonly string[],
  newLines: readonly string[],
  oldIndex: number,
  newIndex: number,
): boolean {
  return (
    oldIndex < oldLines.length &&
    newIndex < newLines.length &&
    oldLines[oldIndex] === newLines[newIndex]
  );
}

function noChanges(
  oldText: string | undefined,
  truncated: boolean,
  rows: readonly DiffRow[],
): boolean {
  return (
    oldText !== undefined &&
    !truncated &&
    !rows.some((row) => ["added", "removed"].includes(row.kind))
  );
}

function ProposedChangesNote(): ReactElement {
  return (
    <span className="inline-edit-note" title="Preview from tool arguments; not confirmed by Pi">
      Proposed changes
    </span>
  );
}

function isCompletedFileChange(step: ToolStep): boolean {
  return step.state === "complete" && !step.isError && /^(write|edit)$/i.test(step.toolName);
}

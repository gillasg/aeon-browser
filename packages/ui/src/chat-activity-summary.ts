import { outcomeText, shellOutcome } from "./tool-outcome.js";
import { stringValue, normalizeName, titleCase } from "./tool-label-values.js";
import {
  actionCategory,
  browserActionValues,
  isShellTool,
} from "./tool-activity-classification.js";
import { describeBrowserAction, describeNamedAction } from "./tool-action-labels.js";
import type { ToolStep } from "./transcript-model.js";
import { projectEditDiff } from "./tool-edit-diff.js";

export { isShellTool, toolKind } from "./tool-activity-classification.js";

export function describeToolAction(step: ToolStep): string {
  const name = normalizeName(step.toolName);
  return name.includes("browser") ? describeBrowserAction(step) : describeNamedAction(name, step);
}

export function describeToolGroup(group: { steps: readonly ToolStep[] }): string {
  const leaves = group.steps.filter(
    (step) => !group.steps.some((candidate) => candidate.parentToolCallId === step.toolCallId),
  );
  const actions = leaves.length ? leaves : group.steps.slice(0, 1);
  const single = singleActionLabel(actions);
  if (single) return single;
  const counts = new Map<string, number>();
  for (const step of actions) {
    if (!isFileChange(step)) {
      const category = actionCategory(step);
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  const labels = groupLabels(actions, counts);
  const visible = labels
    .slice(0, 3)
    .map(({ label }, index) => (index ? label.charAt(0).toLowerCase() + label.slice(1) : label));
  const more = labels.slice(3).reduce((sum, item) => sum + item.count, 0);
  if (more) visible.push(`+${more} more`);
  return visible.join(", ");
}

export function toolOutcome(step: ToolStep): string {
  if (step.state === "running") return outcomeText(step.partialResult) || "In progress";
  if (step.state === "pending") return "Starting";
  if (step.isError) return outcomeText(step.result) || "Tool returned an error";
  if (!step.result) return "Completed";
  return isShellTool(step.toolName)
    ? shellOutcome(step.result)
    : outcomeText(step.result) || "Completed";
}

function fileChangeSummary(steps: ToolStep[]): string {
  const files = new Set(steps.map(fileIdentity));
  const diffs = steps.map(projectEditDiff);
  const complete =
    steps.every((step) => step.state === "complete" && !step.isError) &&
    diffs.every((diff) => diff?.confirmed && !diff.truncated);
  const label = files.size === 1 ? "Edited a file" : `Edited ${files.size} files`;
  if (!complete) return label;
  const added = diffs.reduce((sum, diff) => sum + (diff?.added ?? 0), 0);
  const removed = diffs.reduce((sum, diff) => sum + (diff?.removed ?? 0), 0);
  return `${label} +${added} −${removed}`;
}

function fileIdentity(step: ToolStep): string {
  const path = stringValue(step.arguments, "path", "filePath", "file_path", "file", "filename");
  return path ? path.replace(/\\/g, "/") : `tool:${step.toolCallId}`;
}

function groupLabels(
  actions: readonly ToolStep[],
  counts: ReadonlyMap<string, number>,
): Array<{ label: string; count: number }> {
  const changed = actions.filter(isFileChange);
  return [
    ...(changed.length ? [{ label: fileChangeSummary(changed), count: changed.length }] : []),
    ...[...counts].map(([category, count]) => ({
      label: actionGroupLabel(category, count),
      count,
    })),
  ];
}

function isFileChange(step: ToolStep | undefined): boolean {
  return Boolean(step && /^(?:file-edit|file-write)$/.test(actionCategory(step)));
}

function singleActionLabel(actions: readonly ToolStep[]): string | undefined {
  const step = actions[0];
  if (actions.length !== 1 || !step || isFileChange(step)) return undefined;
  if (browserActionValues(step.arguments).length > 1) return "Browsed the web, ran actions";
  return actionGroupLabel(actionCategory(step), 1);
}

function actionGroupLabel(category: string, count: number): string {
  const labels: Record<string, readonly [string, string]> = {
    "browser-search": ["Searched the web", "Searched the web {n} times"],
    "browser-tabs": ["Checked browser tabs", "Checked browser tabs {n} times"],
    "browser-history": ["Browsed history", "Browsed history {n} times"],
    "browser-capture": ["Captured a screenshot", "Captured {n} screenshots"],
    "browser-read": ["Read a web page", "Read {n} web pages"],
    "browser-scroll": ["Scrolled a page", "Scrolled a page {n} times"],
    "browser-browse": ["Browsed the web", "Browsed the web"],
    "memory-search": ["Searched memory", "Searched memory {n} times"],
    "file-edit": ["Edited a file", "Edited {n} files"],
    "file-write": ["Wrote a file", "Wrote {n} files"],
    "file-delete": ["Deleted a file", "Deleted {n} files"],
    "file-read": ["Read a file", "Read {n} files"],
    shell: ["Ran commands", "Ran commands"],
    code: ["Ran code", "Ran {n} code actions"],
  };
  const pair = labels[category];
  if (pair) return pair[count === 1 ? 0 : 1].replace("{n}", String(count));
  return "Used " + titleCase(category.slice("other:".length)) + (count === 1 ? "" : " " + count);
}

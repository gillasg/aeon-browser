import { normalizeName, stringValue } from "./tool-label-values.js";
import type { ToolStep } from "./transcript-model.js";

const fileCategories: ReadonlyArray<readonly [RegExp, string]> = [
  [/edit/, "file-edit"],
  [/write/, "file-write"],
  [/delete|remove/, "file-delete"],
  [/read|openfile/, "file-read"],
  [/code/, "code"],
];

export function actionCategory(step: ToolStep): string {
  const name = normalizeName(step.toolName);
  if (name.includes("browser"))
    return /history/.test(name) ? "browser-history" : browserCategory(step);
  if (/memory.*search|search.*memory/.test(name)) return "memory-search";
  if (/history/.test(name)) return "browser-history";
  if (/web.*search|search.*web/.test(name)) return "browser-search";
  if (/web.*(?:fetch|read)|(?:fetch|read).*web/.test(name)) return "browser-read";
  const category = fileCategories.find(([pattern]) => pattern.test(name))?.[1];
  return category ?? (isShellTool(step.toolName) ? "shell" : `other:${step.toolName}`);
}

export function browserActionValues(args: Record<string, unknown>): Record<string, unknown>[] {
  const actions = args.steps ?? args.actions;
  if (!Array.isArray(actions)) return [];
  return actions.filter(
    (action): action is Record<string, unknown> =>
      typeof action === "object" && action !== null && !Array.isArray(action),
  );
}

export function browserOperationFromToolName(toolName: string): string | undefined {
  const name = toolName.toLowerCase();
  const operation = browserOperations.find(([pattern]) => pattern.test(name));
  return operation?.[1];
}

export function isShellTool(toolName: string): boolean {
  return /(?:shell|bash|terminal|command|exec)/i.test(toolName);
}

export function lastBrowserAction(args: Record<string, unknown>): Record<string, unknown> {
  const steps = args.steps ?? args.actions;
  if (!Array.isArray(steps)) return args;
  const last = steps.at(-1);
  return last && typeof last === "object" && !Array.isArray(last)
    ? (last as Record<string, unknown>)
    : args;
}

export function toolKind(toolName: string): "browser" | "file" | "shell" | "code" | "other" {
  if (/browser|tab|web/i.test(toolName)) return "browser";
  if (/edit|write|read|delete|file|patch/i.test(toolName)) return "file";
  if (/^(?:code|code.?mode|codemode|run.?code)$/i.test(toolName)) return "code";
  return isShellTool(toolName) ? "shell" : "other";
}

function browserCategory(step: ToolStep): string {
  const action = lastBrowserAction(step.arguments);
  const operation = normalizeName(
    stringValue(action, "op", "action", "operation", "type") ??
      browserOperationFromToolName(step.toolName) ??
      "",
  );
  return browserCategories.find(([pattern]) => pattern.test(operation))?.[1] ?? "browser-browse";
}

const browserCategories: ReadonlyArray<readonly [RegExp, string]> = [
  [/search|find/, "browser-search"],
  [/history/, "browser-history"],
  [/listtabs|tabslist|tablist/, "browser-tabs"],
  [/screenshot|capture/, "browser-capture"],
  [/read|snapshot|extract|getpage/, "browser-read"],
  [/scroll/, "browser-scroll"],
];

const browserOperations: ReadonlyArray<readonly [RegExp, string]> = [
  [/history/, "history"],
  [/navigate|goto|openurl|createtab|newtab/, "navigate"],
  [/click|press|type|fill|select/, "click"],
  [/scroll/, "scroll"],
  [/screenshot|capture/, "screenshot"],
  [/snapshot|readpage|extract|content/, "snapshot"],
  [/search|find/, "search"],
];

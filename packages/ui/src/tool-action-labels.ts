import {
  boundedText,
  fileName,
  isRecord,
  normalizeName,
  siteName,
  stringValue,
  titleCase,
} from "./tool-label-values.js";
import {
  browserOperationFromToolName,
  isShellTool,
  lastBrowserAction,
} from "./tool-activity-classification.js";
import type { ToolStep } from "./transcript-model.js";

export function describeBrowserAction(step: ToolStep): string {
  const action = lastBrowserAction(step.arguments);
  const operation = stringValue(action, "op", "action", "operation", "type")
    ? action
    : { ...action, op: browserOperationFromToolName(step.toolName) ?? "" };
  const description = describeBrowserOperation(operation);
  const query = stringValue(action, "query", "searchQuery", "search_query");
  if (query && /search|find/i.test(description))
    return `${step.state === "running" ? "Searching" : "Searched"} “${boundedText(query)}”`;
  if (siteName(operation) || !siteName(step.arguments))
    return step.state === "running" ? progressive(description) : description;
  const site = siteName(step.arguments);
  const label = description.endsWith(" on") ? description.slice(0, -3) : description;
  return site ? `${step.state === "running" ? progressive(label) : label} ${site}` : label;
}

export function describeBrowserOperation(
  action: Record<string, unknown>,
  result?: unknown,
): string {
  const operation = normalizeName(stringValue(action, "op", "action", "operation", "type") ?? "");
  const site = siteName(action) ?? browserResultSite(result);
  const target = browserTarget(action);
  const known =
    describeTabList(operation, result) ??
    describeScroll(operation, action, site) ??
    describeControl(operation, "click", target, site) ??
    describeControl(operation, "press", target, site) ??
    describeControl(operation, "fill", target, site);
  if (known) return known;
  const label = browserActionLabel(operation);
  const readable = label.endsWith(" on") ? label.slice(0, -3) : label;
  return site ? `${readable} ${site}` : readable;
}

export function describeNamedAction(name: string, step: ToolStep): string {
  const file = fileName(step.arguments);
  const editing = step.state === "running";
  const query = stringValue(step.arguments, "query", "searchQuery", "search_query");
  return (
    describeSearchAction(name, query, editing) ??
    describeWebAction(name, step, editing) ??
    describeFileAction(name, file, editing) ??
    describeOtherAction(name, step, file)
  );
}

function browserActionLabel(operation: string): string {
  const label = browserLabels.find(([pattern]) => pattern.test(operation))?.[1];
  return label ?? (operation ? `Use ${titleCase(operation)}` : "Use browser");
}

function browserResultSite(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = siteName(value);
  if (direct) return direct;
  for (const key of ["tab", "observation", "result"])
    if (isRecord(value[key])) {
      const nested = siteName(value[key] as Record<string, unknown>);
      if (nested) return nested;
    }
  return undefined;
}

function browserResultTitle(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (Array.isArray(value.tabs)) {
    const tabs = value.tabs.filter(isRecord);
    const active = tabs.find((tab) => tab.active) ?? tabs[0];
    if (active) return stringValue(active, "title", "site");
  }
  for (const key of ["tab", "observation", "result"])
    if (isRecord(value[key])) {
      const title = stringValue(value[key] as Record<string, unknown>, "title", "site");
      if (title) return title;
    }
  return stringValue(value, "title", "site");
}

function browserTarget(action: Record<string, unknown>): string | undefined {
  return isRecord(action.element) ? stringValue(action.element, "name", "role") : undefined;
}

function describeControl(
  operation: string,
  kind: "click" | "press" | "fill",
  target: string | undefined,
  site: string | undefined,
): string | undefined {
  if (!target || operation !== kind) return undefined;
  const verb = kind === "fill" ? "Filling" : "Clicking";
  return `${verb} ${target}${site ? ` on ${site}` : ""}`;
}

function describeFileAction(
  name: string,
  file: string | undefined,
  editing: boolean,
): string | undefined {
  const verbs: ReadonlyArray<readonly [RegExp, string, string]> = [
    [/edit/, "Editing", "Edited"],
    [/write/, "Writing", "Wrote"],
    [/delete|remove/, "Deleting", "Deleted"],
    [/read|openfile/, "Reading", "Read"],
  ];
  const match = verbs.find(([pattern]) => pattern.test(name));
  return match ? `${editing ? match[1] : match[2]} ${file ?? "file"}` : undefined;
}

function describeOtherAction(name: string, step: ToolStep, file: string | undefined): string {
  if (name.includes("code")) return "Run code";
  if (isShellTool(step.toolName)) return describeShellAction(step, file);
  if (name.includes("search")) return "Search";
  if (name.includes("fetch") || name.includes("request")) return "Fetch page";
  const readable = step.toolName.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return readable.replace(/\b\w/g, (character) => character.toUpperCase());
}

function describeScroll(
  operation: string,
  action: Record<string, unknown>,
  site: string | undefined,
): string | undefined {
  if (operation !== "scroll") return undefined;
  const direction = stringValue(action, "direction");
  const destination = direction === "up" ? "back up" : direction;
  return `Scrolling ${site ?? "page"}${destination ? ` ${destination}` : ""}`;
}

function describeSearchAction(
  name: string,
  query: string | undefined,
  editing: boolean,
): string | undefined {
  const verb = editing ? "Searching" : "Searched";
  if (/memory.*search|search.*memory/.test(name))
    return `${verb} memory${query ? ` for “${boundedText(query)}”` : ""}`;
  if (/web.*search|search.*web/.test(name))
    return `${verb} the web${query ? ` for “${boundedText(query)}”` : ""}`;
  return undefined;
}

function describeShellAction(step: ToolStep, file: string | undefined): string {
  const command = stringValue(step.arguments, "command", "cmd");
  const deletesFile = command && /(?:^|[;&|\s])(?:rm|del|remove-item)(?:\s|$)/i.test(command);
  const target = file ?? (command ? deletedFileName(command) : undefined);
  if (deletesFile && target) return `Deleting ${target}`;
  return step.state === "running" ? "Running shell command" : "Ran shell command";
}

function describeTabList(operation: string, result: unknown): string | undefined {
  if (!/^(?:listtabs|tabslist|tablist)$/.test(operation)) return undefined;
  const tabName = browserResultTitle(result)?.split(/[\s|·–—,]/, 1)[0];
  return tabName ? `Checking the open ${tabName} tab` : "Checking open browser tabs";
}

function describeWebAction(name: string, step: ToolStep, editing: boolean): string | undefined {
  if (/history/.test(name)) return editing ? "Browsing recent activity" : "Browsed history";
  if (!/web.*(?:fetch|read)|(?:fetch|read).*web/.test(name)) return undefined;
  const site = siteName(step.arguments);
  return `${editing ? "Reading" : "Read"} a web page${site ? ` · ${site}` : ""}`;
}

function deletedFileName(command: string): string | undefined {
  const target = command.match(
    /(?:rm|del|remove-item)\s+(?:-literalpath\s+)?["']?([^\s"';&|]+)/i,
  )?.[1];
  return target?.replace(/\\/g, "/").split("/").at(-1);
}

function progressive(value: string): string {
  const [first = "", ...rest] = value.split(" ");
  return [progressiveVerbs[first] ?? first, ...rest].join(" ");
}

const browserLabels: ReadonlyArray<readonly [RegExp, string]> = [
  [/history/, "Browsing recent activity"],
  [/listtabs|tabslist|tablist/, "Checking open browser tabs"],
  [/scroll/, "Scrolling page"],
  [/click|press/, "Clicking page control on"],
  [/navigate|goto|openurl|opentab|newtab|createtab/, "Opening"],
  [/attach/, "Attaching browser tab"],
  [/observe/, "Observing page"],
  [/read|snapshot|extract|getpage/, "Reading page"],
  [/screenshot|capture/, "Capturing screenshot"],
  [/search|find/, "Searching the web"],
];

const progressiveVerbs: Readonly<Record<string, string>> = {
  Checked: "Checking",
  Scrolled: "Scrolling",
  Clicked: "Clicking",
  Opened: "Opening",
  Read: "Reading",
  Captured: "Capturing",
  Searched: "Searching",
  Browsed: "Browsing",
  Used: "Using",
};

import { INTERACTIVE_ROLES, type ExpandSection, type SemanticTree, type TreeNode } from "./types.js";
import {
  chromeText,
  containerText,
  controlText,
  isChromeRole,
  isDialogRole,
  isSkippableText,
  pageHeading,
  tableText,
  type Line,
} from "./render-model.js";

interface Flags {
  dialog: boolean;
  underRow: boolean;
  inSelect: boolean;
}

interface Build {
  lines: Line[];
  nodes: TreeNode[];
  kids: Map<string, TreeNode[]>;
  pageUrl: string;
  expand: readonly ExpandSection[];
  hot: Set<string>;
  focusZone: Set<string>;
  order: number;
}

export function buildLines(tree: SemanticTree, expand: readonly ExpandSection[], hot: Set<string>): Line[] {
  const ids = new Set(tree.nodes.map((node) => node.axId));
  const build: Build = {
    lines: [],
    nodes: tree.nodes,
    kids: groupKids(tree.nodes),
    pageUrl: tree.url,
    expand,
    hot,
    focusZone: focusZone(tree.nodes),
    order: 1,
  };
  build.lines.push(headerLine(tree));
  if (fewControls(tree.nodes)) build.lines.push(noticeLine(build));
  const roots = tree.nodes.filter((node) => !node.parentAxId || !ids.has(node.parentAxId));
  const flags = { dialog: false, underRow: false, inSelect: false };
  for (const root of roots) walk(root, undefined, flags, build);
  return build.lines;
}

function groupKids(nodes: readonly TreeNode[]): Map<string, TreeNode[]> {
  const kids = new Map<string, TreeNode[]>();
  for (const node of nodes) {
    const key = node.parentAxId ?? "";
    const list = kids.get(key) ?? [];
    list.push(node);
    kids.set(key, list);
  }
  return kids;
}

function headerLine(tree: SemanticTree): Line {
  const text = pageHeading(tree.url, tree.title);
  return baseLine("header", text, "header", "header", "", text);
}

function noticeLine(build: Build): Line {
  const text = "Accessibility tree is almost empty. Use page.act or a screenshot.";
  const line = baseLine("notice", text, "notice", "notice", "", text);
  line.order = build.order++;
  return line;
}

function fewControls(nodes: readonly TreeNode[]): boolean {
  return !nodes.some(
    (node) => !node.clickable && node.role !== "option" && INTERACTIVE_ROLES.has(node.role),
  );
}

const STRUCTURAL = new Set([
  "rootwebarea",
  "webarea",
  "document",
  "generic",
  "none",
  "presentation",
  "inlinetextbox",
]);

function walk(node: TreeNode, parentKey: string | undefined, flags: Flags, build: Build): void {
  if (STRUCTURAL.has(node.role) || skipNode(node, flags)) {
    walkKids(node, parentKey, flags, build);
    return;
  }
  if (isDialogRole(node.role) && parentKey) {
    walk(node, undefined, { dialog: false, underRow: false, inSelect: false }, build);
    return;
  }
  const dialog = flags.dialog || isDialogRole(node.role);
  emit(node, parentKey, dialog, build);
  if (isChromeRole(node.role) && !chromeOpen(node, build)) return;
  walkKids(node, node.axId, childFlags(node, flags, dialog), build);
}

function walkKids(node: TreeNode, parentKey: string | undefined, flags: Flags, build: Build): void {
  for (const child of build.kids.get(node.axId) ?? []) walk(child, parentKey, flags, build);
}

function childFlags(node: TreeNode, flags: Flags, dialog: boolean): Flags {
  return {
    dialog,
    underRow: rowFlags(flags.underRow, node.role),
    inSelect: selectFlags(flags.inSelect, node.role),
  };
}

function rowFlags(underRow: boolean, role: string): boolean {
  return underRow || role === "row" || role === "listitem";
}

function selectFlags(inSelect: boolean, role: string): boolean {
  return inSelect || role === "combobox" || role === "listbox";
}

function skipNode(node: TreeNode, flags: Flags): boolean {
  if (node.role === "option" && flags.inSelect) return true;
  if (!flags.underRow || node.role === "row" || node.role === "listitem") return false;
  return isSkippableText(node.role);
}

function chromeOpen(node: TreeNode, build: Build): boolean {
  if (build.expand.includes("all")) return true;
  if (node.role === "navigation" && build.expand.includes("nav")) return true;
  if (node.role === "contentinfo" && build.expand.includes("footer")) return true;
  return build.hot.has(node.axId);
}

function emit(node: TreeNode, parentKey: string | undefined, dialog: boolean, build: Build): void {
  const line = node.container ? containerLine(node, dialog, build) : contentLine(node, dialog, build);
  if (!line) return;
  if (parentKey) line.parentKey = parentKey;
  line.order = build.order++;
  build.lines.push(line);
}

function containerLine(node: TreeNode, dialog: boolean, build: Build): Line {
  const text = isChromeRole(node.role)
    ? chromeText(node, countRole(node, "link", build), countRole(node, "button", build))
    : containerBody(node, build);
  const line = baseLine(node.axId, text, sectionOf(node, dialog, build), "container", node.role, node.name);
  line.hay = `${node.role} ${node.name} ${text}`.toLowerCase();
  line.row = node.role === "row";
  line.table = node.role === "table";
  if (node.backendNodeId !== undefined) line.id = node.backendNodeId;
  return line;
}

function containerBody(node: TreeNode, build: Build): string {
  if (node.role !== "table") return containerText(node);
  const rows = (build.kids.get(node.axId) ?? []).filter((child) => child.role === "row").length;
  return tableText(node.name, rows, rows);
}

function contentLine(node: TreeNode, dialog: boolean, build: Build): Line | undefined {
  if (node.role === "heading") return textLine(node, dialog, build, "heading", `## ${node.name}`);
  if (isSkippableText(node.role)) return textLine(node, dialog, build, "text", node.name);
  const token = tokenOf(node);
  if (!token) return undefined;
  const text = controlText(node, build.pageUrl, token);
  const line = textLine(node, dialog, build, "control", text);
  line.token = token;
  if (node.value !== undefined) line.value = node.value;
  line.section = controlSection(node, dialog);
  return line;
}

function textLine(node: TreeNode, dialog: boolean, build: Build, kind: Line["kind"], text: string): Line {
  const line = baseLine(node.axId, text, sectionOf(node, dialog, build), kind, node.role, node.name);
  line.hay = `${node.role} ${node.name} ${node.value ?? ""} ${node.options?.join(" ") ?? ""} ${text}`.toLowerCase();
  if (node.backendNodeId !== undefined) line.id = node.backendNodeId;
  return line;
}

function controlSection(node: TreeNode, dialog: boolean): Line["section"] {
  if (dialog) return "dialog";
  if (node.focused) return "focus";
  return "control";
}

function sectionOf(node: TreeNode, dialog: boolean, build: Build): Line["section"] {
  if (dialog) return "dialog";
  if (node.role === "form" && build.focusZone.has(node.axId)) return "focus";
  if (isChromeRole(node.role)) return "chrome";
  if (node.role === "heading") return "heading";
  if (isSkippableText(node.role)) return "text";
  return "control";
}

function tokenOf(node: TreeNode): string | undefined {
  if (node.frame && node.ref) return node.ref;
  if (node.backendNodeId !== undefined) return String(node.backendNodeId);
  return node.ref;
}

function countRole(node: TreeNode, role: string, build: Build): number {
  let count = 0;
  const stack = [...(build.kids.get(node.axId) ?? [])];
  let guard = 0;
  while (stack.length && guard++ < 500) {
    const child = stack.pop();
    if (!child) continue;
    if (child.role === role) count += 1;
    stack.push(...(build.kids.get(child.axId) ?? []));
  }
  return count;
}

function focusZone(nodes: readonly TreeNode[]): Set<string> {
  const focused = nodes.find((node) => node.focused);
  if (!focused) return new Set();
  const byId = new Map(nodes.map((node) => [node.axId, node]));
  const root = formAncestor(focused, byId) ?? focused.axId;
  const zone = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const id = stack.pop();
    if (!id || zone.has(id)) continue;
    zone.add(id);
    for (const node of nodes) if (node.parentAxId === id) stack.push(node.axId);
  }
  return zone;
}

function formAncestor(node: TreeNode, byId: Map<string, TreeNode>): string | undefined {
  let current: TreeNode | undefined = node;
  let formId: string | undefined;
  let guard = 0;
  while (current && guard++ < 200) {
    if (current.role === "form") formId = current.axId;
    current = current.parentAxId ? byId.get(current.parentAxId) : undefined;
  }
  return formId;
}

function baseLine(
  key: string,
  text: string,
  section: Line["section"],
  kind: Line["kind"],
  role: string,
  bareName: string,
): Line {
  return {
    key,
    order: 0,
    depth: 0,
    section,
    kind,
    role,
    bareName,
    text,
    hay: text.toLowerCase(),
    row: false,
    table: false,
  };
}

export function hotNodes(nodes: readonly TreeNode[], focus: string | undefined, delta: Set<number> | undefined): Set<string> {
  const byId = new Map(nodes.map((node) => [node.axId, node]));
  const hot = new Set<string>();
  const query = focus?.toLowerCase();
  for (const node of nodes) {
    if (!nodeIsHot(node, query, delta)) continue;
    let current: TreeNode | undefined = node;
    let guard = 0;
    while (current && guard++ < 200) {
      hot.add(current.axId);
      current = current.parentAxId ? byId.get(current.parentAxId) : undefined;
    }
  }
  return hot;
}

function nodeIsHot(node: TreeNode, query: string | undefined, delta: Set<number> | undefined): boolean {
  if (query && `${node.role} ${node.name} ${node.value ?? ""}`.toLowerCase().includes(query)) return true;
  return delta !== undefined && node.backendNodeId !== undefined && delta.has(node.backendNodeId);
}

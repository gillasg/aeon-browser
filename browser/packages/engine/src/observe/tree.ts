import type { BrowserSemanticNode } from "@browserkit/protocol";
import type { AxNode } from "../native-browser-common.js";
import { textValue } from "../native-browser-common.js";
import {
  CELL_ROLES,
  CONTAINER_ROLES,
  INTERACTIVE_ROLES,
  TEXT_ROLES,
  clip,
  type ResolvedClickable,
  type SemanticTree,
  type TreeNode,
} from "./types.js";

export function buildSemanticTree(input: {
  ax: readonly AxNode[];
  shown: readonly BrowserSemanticNode[];
  url: string;
  title?: string;
  clickables?: readonly ResolvedClickable[];
  offscreen?: readonly string[];
}): SemanticTree {
  const byId = indexById(input.ax);
  const kids = childrenOf(input.ax);
  const include = includedIds(input.ax, input.shown, byId, kids);
  const shownById = new Map(
    input.shown.flatMap((node) =>
      node.backendNodeId === undefined ? [] : [[node.backendNodeId, node] as const],
    ),
  );
  const offscreen = new Set(input.offscreen ?? []);
  const nodes = input.ax.flatMap((ax) => {
    if (!ax.nodeId || !include.has(ax.nodeId)) return [];
    return [toTreeNode(ax, include, byId, kids, shownById, offscreen)];
  });
  appendClickables(nodes, input.clickables ?? []);
  return { url: input.url, title: titleOf(input.ax, input.title), nodes };
}

function indexById(nodes: readonly AxNode[]): Map<string, AxNode> {
  const byId = new Map<string, AxNode>();
  for (const node of nodes) if (node.nodeId) byId.set(node.nodeId, node);
  return byId;
}

function childrenOf(nodes: readonly AxNode[]): Map<string, AxNode[]> {
  const kids = new Map<string, AxNode[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const list = kids.get(node.parentId) ?? [];
    list.push(node);
    kids.set(node.parentId, list);
  }
  return kids;
}

function includedIds(
  ax: readonly AxNode[],
  shown: readonly BrowserSemanticNode[],
  byId: Map<string, AxNode>,
  kids: Map<string, AxNode[]>,
): Set<string> {
  const byBackend = new Map(
    ax.flatMap((node) =>
      node.backendDOMNodeId === undefined || !node.nodeId
        ? []
        : [[node.backendDOMNodeId, node] as const],
    ),
  );
  const include = new Set<string>();
  const memo = new Map<string, boolean>();
  for (const node of shown) {
    const match = node.backendNodeId === undefined ? undefined : byBackend.get(node.backendNodeId);
    if (!match?.nodeId) continue;
    include.add(match.nodeId);
    addContainers(match, include, byId, kids, memo);
  }
  return include;
}

function addContainers(
  start: AxNode,
  include: Set<string>,
  byId: Map<string, AxNode>,
  kids: Map<string, AxNode[]>,
  memo: Map<string, boolean>,
): void {
  let parent = start.parentId;
  let guard = 0;
  while (parent && guard++ < 200) {
    const ancestor = byId.get(parent);
    if (!ancestor?.nodeId) break;
    if (isContainer(ancestor, kids, memo)) include.add(ancestor.nodeId);
    parent = ancestor.parentId;
  }
}

function isContainer(
  node: AxNode,
  kids: Map<string, AxNode[]>,
  memo: Map<string, boolean>,
): boolean {
  const role = roleOf(node);
  if (role === "region") return nameOf(node).trim().length > 0;
  if (role === "listitem") return holdsControl(node, kids, memo);
  return CONTAINER_ROLES.has(role);
}

function holdsControl(
  node: AxNode,
  kids: Map<string, AxNode[]>,
  memo: Map<string, boolean>,
): boolean {
  const id = node.nodeId;
  if (!id) return false;
  const known = memo.get(id);
  if (known !== undefined) return known;
  memo.set(id, false);
  const found =
    INTERACTIVE_ROLES.has(roleOf(node)) ||
    (kids.get(id) ?? []).some((child) => holdsControl(child, kids, memo));
  memo.set(id, found);
  return found;
}

function toTreeNode(
  ax: AxNode,
  include: Set<string>,
  byId: Map<string, AxNode>,
  kids: Map<string, AxNode[]>,
  shownById: Map<number, BrowserSemanticNode>,
  offscreen: Set<string>,
): TreeNode {
  const shown = ax.backendDOMNodeId === undefined ? undefined : shownById.get(ax.backendDOMNodeId);
  const role = (shown?.role || roleOf(ax)).toLowerCase();
  const name = clip(shown?.name || nameOf(ax), 512);
  const base = nodeFromAx(ax, role, name, include, byId, kids);
  const merged = shown ? applyShown(base, shown) : base;
  if (offscreen.has(`${merged.role}|${merged.name}`)) merged.offscreen = true;
  if (isContainer(ax, kids, new Map())) merged.container = true;
  const label = rowLabel(ax, kids);
  if (label && (role === "row" || role === "listitem")) merged.name = label;
  return merged;
}

function nodeFromAx(
  ax: AxNode,
  role: string,
  name: string,
  include: Set<string>,
  byId: Map<string, AxNode>,
  kids: Map<string, AxNode[]>,
): TreeNode {
  const parentAxId = nearestIncluded(ax, include, byId);
  const options = optionNames(ax, kids);
  const invalid = invalidMessage(ax);
  const placeholder = property(ax, "placeholder");
  const url = property(ax, "url");
  return {
    axId: ax.nodeId ?? "",
    role,
    name,
    ...(parentAxId ? { parentAxId } : {}),
    ...(ax.backendDOMNodeId !== undefined ? { backendNodeId: ax.backendDOMNodeId } : {}),
    ...(url ? { url } : {}),
    ...(property(ax, "required") === "true" ? { required: true } : {}),
    ...(invalid ? { invalid } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(options ? { options } : {}),
  };
}

function applyShown(node: TreeNode, shown: BrowserSemanticNode): TreeNode {
  return {
    ...node,
    name: shown.name || node.name,
    ...(shown.ref ? { ref: shown.ref } : {}),
    ...(shown.frame ? { frame: shown.frame } : {}),
    ...(shown.value !== undefined ? { value: shown.value } : {}),
    ...(shown.disabled !== undefined ? { disabled: shown.disabled } : {}),
    ...(shown.checked !== undefined ? { checked: shown.checked } : {}),
    ...(shown.focused !== undefined ? { focused: shown.focused } : {}),
    ...(shown.expanded !== undefined ? { expanded: shown.expanded } : {}),
    ...(shown.selected !== undefined ? { selected: shown.selected } : {}),
    ...(shown.pressed !== undefined ? { pressed: shown.pressed } : {}),
    ...(shown.mixed !== undefined ? { mixed: shown.mixed } : {}),
    ...(shown.hidden !== undefined ? { hidden: shown.hidden } : {}),
  };
}

function nearestIncluded(
  node: AxNode,
  include: Set<string>,
  byId: Map<string, AxNode>,
): string | undefined {
  let parent = node.parentId;
  let guard = 0;
  while (parent && guard++ < 200) {
    if (include.has(parent) && parent !== node.nodeId) return parent;
    parent = byId.get(parent)?.parentId;
  }
  return undefined;
}

function optionNames(node: AxNode, kids: Map<string, AxNode[]>): string[] | undefined {
  const role = roleOf(node);
  if (role !== "combobox" && role !== "listbox") return undefined;
  const names: string[] = [];
  collectOptions(node, kids, names, 0);
  return names.length ? names : undefined;
}

function collectOptions(
  node: AxNode,
  kids: Map<string, AxNode[]>,
  names: string[],
  depth: number,
): void {
  if (depth > 6) return;
  for (const child of kids.get(node.nodeId ?? "") ?? []) {
    if (roleOf(child) === "option") {
      const name = nameOf(child).trim();
      if (name) names.push(clip(name, 40));
    } else collectOptions(child, kids, names, depth + 1);
  }
}

function rowLabel(node: AxNode, kids: Map<string, AxNode[]>): string {
  const role = roleOf(node);
  if (role !== "row" && role !== "listitem") return "";
  const texts: string[] = [];
  collectTexts(node, kids, texts, 0);
  return clip(texts.slice(0, 2).join(" · "), 60);
}

function collectTexts(
  node: AxNode,
  kids: Map<string, AxNode[]>,
  texts: string[],
  depth: number,
): void {
  if (depth > 8 || texts.length >= 2) return;
  for (const child of kids.get(node.nodeId ?? "") ?? []) {
    const role = roleOf(child);
    if (INTERACTIVE_ROLES.has(role)) continue;
    if (TEXT_ROLES.has(role) || CELL_ROLES.has(role)) pushText(texts, nameOf(child));
    if (!TEXT_ROLES.has(role)) collectTexts(child, kids, texts, depth + 1);
  }
}

function pushText(texts: string[], name: string): void {
  const text = clip(name, 40);
  if (text && !texts.includes(text)) texts.push(text);
}

function appendClickables(nodes: TreeNode[], hits: readonly ResolvedClickable[]): void {
  const used = new Set(nodes.map((node) => node.backendNodeId));
  const main = nodes.find((node) => node.role === "main");
  for (const hit of hits) {
    if (used.has(hit.backendNodeId) || nodes.length >= 220) continue;
    used.add(hit.backendNodeId);
    nodes.push({
      axId: `click-${hit.backendNodeId}`,
      role: "clickable",
      name: clip(hit.text, 80),
      backendNodeId: hit.backendNodeId,
      clickable: true,
      ...(main ? { parentAxId: main.axId } : {}),
      ...(hit.offscreen ? { offscreen: true } : {}),
    });
  }
}

function titleOf(ax: readonly AxNode[], given: string | undefined): string {
  if (given?.trim()) return given.trim();
  const root = ax.find((node) => roleOf(node) === "rootwebarea");
  return root ? nameOf(root).trim() : "";
}

function invalidMessage(node: AxNode): string | undefined {
  const value = property(node, "invalid");
  if (!value || value === "false") return undefined;
  const message = property(node, "errormessage");
  if (message && !/^axnode/i.test(message)) return clip(message, 80);
  return value === "true" ? "invalid" : clip(value, 80);
}

function property(node: AxNode, name: string): string {
  const value = node.properties?.find((item) => item.name === name)?.value?.value;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

function roleOf(node: AxNode): string {
  return textValue(node.role?.value).toLowerCase();
}

function nameOf(node: AxNode): string {
  return textValue(node.name?.value);
}

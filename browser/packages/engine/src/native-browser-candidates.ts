// Who else was on the page when a target failed: the matches, the nearest names, or the control
// that opens a hidden one's container. At most eight, so the list replaces a second state read.
import type { ErrorCandidate } from "@browserkit/protocol";
import { BrowserActionError, textValue, type AxNode } from "./native-browser-common.js";

const PRESS = new Set(["button", "link", "menuitem"]);
const TYPE = new Set(["textbox", "searchbox", "combobox"]);
const CHECK = new Set(["checkbox", "radio", "switch"]);
const INTERACTIVE = new Set([...PRESS, ...TYPE, ...CHECK, "tab", "option", "slider", "spinbutton"]);
const OPENERS = new Set(["button", "link", "summary"]);

export interface TargetLabel {
  role: string;
  name: string;
  selector?: string;
}

function roleOf(node: AxNode): string {
  return textValue(node.role?.value).toLowerCase();
}

function nameOf(node: AxNode): string {
  return textValue(node.name?.value).replace(/\s+/g, " ").trim().slice(0, 80);
}

function indexNodes(tree: AxNode[]): Map<string, AxNode> {
  const byId = new Map<string, AxNode>();
  for (const node of tree) if (node.nodeId) byId.set(node.nodeId, node);
  return byId;
}

function sameFamily(left: string, right: string): boolean {
  for (const family of [PRESS, TYPE, CHECK]) if (family.has(left) && family.has(right)) return true;
  return false;
}

function compatible(wanted: string, found: string): boolean {
  const left = wanted.toLowerCase();
  if (!left) return INTERACTIVE.has(found);
  return left === found || sameFamily(left, found);
}

/** How close two control names are. Zero means there is nothing to offer. */
export function nameScore(wanted: string, found: string): number {
  const left = wanted.toLowerCase().trim();
  const right = found.toLowerCase().trim();
  if (!left || !right) return 0;
  if (left === right) return 100;
  if (right.includes(left) || left.includes(right)) return 80;
  const words = new Set(left.split(/\s+/).filter((word) => word.length > 1));
  let shared = 0;
  for (const word of right.split(/\s+/)) if (words.has(word)) shared += 1;
  return shared * 20;
}

function rowContext(tree: AxNode[], node: AxNode): string | undefined {
  const byId = indexNodes(tree);
  let current: AxNode | undefined = node;
  for (let depth = 0; current && depth < 12; depth++) {
    const role = roleOf(current);
    if (role === "row" || role === "listitem") {
      const name = nameOf(current);
      return name ? `row: ${name}` : undefined;
    }
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return undefined;
}

function toCandidate(tree: AxNode[], node: AxNode): ErrorCandidate {
  const context = rowContext(tree, node);
  return {
    id: node.backendDOMNodeId ?? 0,
    role: roleOf(node) || "element",
    name: nameOf(node) || roleOf(node) || "element",
    ...(context ? { context } : {}),
  };
}

/** The controls that all matched, capped at eight, with the row each sits in. */
export function ambiguousCandidates(tree: AxNode[], matches: AxNode[]): ErrorCandidate[] {
  const out: ErrorCandidate[] = [];
  for (const node of matches) {
    if (out.length >= 8) break;
    if (node.backendDOMNodeId === undefined) continue;
    out.push(toCandidate(tree, node));
  }
  return out;
}

/** Nearest named controls of a compatible role, best name first, at most eight. */
export function nearestCandidates(tree: AxNode[], role: string, name: string): ErrorCandidate[] {
  const ranked: { score: number; node: AxNode }[] = [];
  for (const node of tree) {
    if (node.ignored || node.backendDOMNodeId === undefined) continue;
    const foundRole = roleOf(node);
    const foundName = nameOf(node);
    if (!compatible(role, foundRole) || !foundName) continue;
    const score = nameScore(name, foundName);
    if (score <= 0) continue;
    ranked.push({ score, node });
  }
  ranked.sort((left, right) => right.score - left.score);
  return ranked.slice(0, 8).map((item) => toCandidate(tree, item.node));
}

function expanded(node: AxNode): boolean | undefined {
  const value = node.properties?.find((item) => item.name === "expanded")?.value?.value;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "false") return value === "true";
  return undefined;
}

function siblingOpener(tree: AxNode[], parentId: string, self: AxNode): AxNode | undefined {
  const siblings = tree.filter(
    (node) => node.parentId === parentId && node !== self && !node.ignored,
  );
  const collapsed = siblings.find((node) => OPENERS.has(roleOf(node)) && expanded(node) === false);
  if (collapsed) return collapsed;
  return siblings.find((node) => OPENERS.has(roleOf(node)) && node.backendDOMNodeId !== undefined);
}

/** The button or link that opens the container of a hidden control, when the tree shows one. */
export function openerCandidate(
  tree: AxNode[],
  hidden: AxNode | undefined,
): ErrorCandidate | undefined {
  if (!hidden) return undefined;
  const byId = indexNodes(tree);
  let current: AxNode | undefined = hidden;
  for (let depth = 0; current && depth < 8; depth++) {
    const parent: AxNode | undefined = current.parentId ? byId.get(current.parentId) : undefined;
    if (!parent?.nodeId) return undefined;
    const opener = siblingOpener(tree, parent.nodeId, current);
    if (opener?.backendDOMNodeId !== undefined) return toCandidate(tree, opener);
    current = parent;
  }
  return undefined;
}

export function notFoundError(tree: AxNode[], role: string, name: string): BrowserActionError {
  return new BrowserActionError("TARGET_NOT_FOUND", `No ${role} named ${JSON.stringify(name)}`, {
    candidates: nearestCandidates(tree, role, name),
    target: { ...(role ? { role } : {}), name },
  });
}

export function ambiguousError(
  tree: AxNode[],
  matches: AxNode[],
  label: TargetLabel,
): BrowserActionError {
  const what = label.role || "element";
  return new BrowserActionError(
    "AMBIGUOUS_TARGET",
    `${matches.length} ${what} elements named ${JSON.stringify(label.name)}`,
    {
      candidates: ambiguousCandidates(tree, matches),
      target: {
        role: label.role,
        name: label.name,
        ...(label.selector ? { selector: label.selector } : {}),
      },
    },
  );
}

export function hiddenError(
  tree: AxNode[],
  hidden: AxNode | undefined,
  detail: string,
  target?: TargetLabel,
): BrowserActionError {
  const opener = openerCandidate(tree, hidden);
  return new BrowserActionError("TARGET_HIDDEN", detail, {
    ...(opener ? { candidates: [opener] } : {}),
    ...(target
      ? {
          target: {
            role: target.role,
            name: target.name,
            ...(target.selector ? { selector: target.selector } : {}),
          },
        }
      : {}),
  });
}

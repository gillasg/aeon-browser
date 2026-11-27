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

/** Edit distance between two short strings, cut off once it passes `limit`. */
function editDistance(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    let best = row;
    for (let col = 1; col <= right.length; col++) {
      const swap = left[row - 1] === right[col - 1] ? 0 : 1;
      const value = Math.min(previous[col]! + 1, current[col - 1]! + 1, previous[col - 1]! + swap);
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length]!;
}

/** A typo-level miss ("Sav chnges" for "Save changes"): up to a third of the name may differ. */
function typoScore(left: string, right: string): number {
  const limit = Math.max(1, Math.floor(Math.max(left.length, right.length) / 3));
  const distance = editDistance(left, right, limit);
  if (distance > limit) return 0;
  return Math.round(70 - (distance / limit) * 30);
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
  return Math.max(shared * 20, typoScore(left, right.slice(0, 80)));
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

/** Nodes scanned for a hint, so a huge page never slows an error down. */
const SCAN_CAP = 4000;
const NEAREST_CAP = 5;

function rankNearest(
  tree: AxNode[],
  name: string,
  keep: (role: string) => boolean,
): ErrorCandidate[] {
  const ranked: { score: number; node: AxNode }[] = [];
  for (const node of tree.slice(0, SCAN_CAP)) {
    if (node.ignored || node.backendDOMNodeId === undefined) continue;
    const foundName = nameOf(node);
    if (!foundName || !keep(roleOf(node))) continue;
    const score = nameScore(name, foundName);
    if (score > 0) ranked.push({ score, node });
  }
  ranked.sort((left, right) => right.score - left.score);
  return ranked.slice(0, NEAREST_CAP).map((item) => toCandidate(tree, item.node));
}

function hasRole(tree: AxNode[], role: string): boolean {
  return tree
    .slice(0, SCAN_CAP)
    .some((node) => !node.ignored && compatible(role, roleOf(node)) && nameOf(node) !== "");
}

/** Nearest named controls of a compatible role, best name first, at most five. */
export function nearestCandidates(tree: AxNode[], role: string, name: string): ErrorCandidate[] {
  return rankNearest(tree, name, (found) => compatible(role, found));
}

/** A page with none of the wanted role offers the closest names of any interactive role. */
export function notFoundError(tree: AxNode[], role: string, name: string): BrowserActionError {
  const none = Boolean(role) && !hasRole(tree, role);
  const candidates = none
    ? rankNearest(tree, name, (found) => INTERACTIVE.has(found) || found === "heading")
    : nearestCandidates(tree, role, name);
  const missing = `No ${role} named ${JSON.stringify(name)}`;
  const detail = none ? `${missing}. The page has no ${role} elements` : missing;
  const shown = candidates.length ? `; closest: ${candidates.length} below` : "";
  return new BrowserActionError("TARGET_NOT_FOUND", detail + shown, {
    candidates,
    target: { ...(role ? { role } : {}), name },
  });
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

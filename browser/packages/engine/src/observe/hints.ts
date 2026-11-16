import { INTERACTIVE_ROLES, type TreeNode } from "./types.js";

const HINT_CAP = 30;

/** Controls whose printed name is empty or shared, and that a named row does not already explain. */
export function hintTargets(nodes: readonly TreeNode[]): TreeNode[] {
  const byId = new Map(nodes.map((node) => [node.axId, node]));
  const counts = new Map<string, number>();
  const controls = nodes.filter(isHintControl);
  for (const node of controls) {
    const label = printedName(node);
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const wanted: TreeNode[] = [];
  for (const node of controls) {
    if (wanted.length >= HINT_CAP) break;
    if (node.frame || node.backendNodeId === undefined) continue;
    if (underNamedRow(node, byId)) continue;
    const label = printedName(node);
    if (label && (counts.get(label) ?? 0) < 2) continue;
    wanted.push(node);
  }
  return wanted;
}

function isHintControl(node: TreeNode): boolean {
  return Boolean(node.ref) && (node.clickable === true || INTERACTIVE_ROLES.has(node.role));
}

function printedName(node: TreeNode): string {
  return (node.name || node.placeholder || "").replace(/\s+/g, " ").trim();
}

function underNamedRow(node: TreeNode, byId: Map<string, TreeNode>): boolean {
  let current = node.parentAxId ? byId.get(node.parentAxId) : undefined;
  let guard = 0;
  while (current && guard++ < 200) {
    if ((current.role === "row" || current.role === "listitem") && printedName(current))
      return true;
    current = current.parentAxId ? byId.get(current.parentAxId) : undefined;
  }
  return false;
}

/** Icon, image file, one stable attribute, then the nearest row. Runs on the element itself. */
export function controlHint(this: Element): string {
  const use = this.querySelector("svg use");
  const link = use?.getAttribute("href") || use?.getAttribute("xlink:href") || "";
  const hash = link.includes("#") ? (link.split("#").pop() ?? "") : "";
  const svg = this.querySelector("svg");
  const drawn = hash || svg?.getAttribute("id") || svg?.getAttribute("data-icon") || "";
  const mark = this.querySelector("svg, i");
  const token =
    drawn ||
    (mark?.getAttribute("class") || "")
      .split(/\s+/)
      .find((name) => /icon|fa-|bi-|mdi-|ri-|ti-/.test(name)) ||
    "";
  const src = this.querySelector("img")?.getAttribute("src") || "";
  const file =
    !src || src.startsWith("data:")
      ? ""
      : (src.split(/[?#]/)[0]?.split("/").pop() ?? "").replace(/\.[A-Za-z0-9]+$/, "");
  let attr = "";
  for (const key of ["data-testid", "name", "id"]) {
    const value = this.getAttribute(key) || "";
    if (/^[A-Za-z][\w-]*$/.test(value) && !/\d{3}/.test(value)) {
      attr = `${key}:${value}`;
      break;
    }
  }
  const row = this.closest("tr, li, article, [role='row'], [role='listitem']");
  const near = row
    ? (row.textContent ?? "")
        .replace(this.textContent ?? "", "")
        .replace(/\s+/g, " ")
        .trim()
    : "";
  return [token ? `icon:${token}` : "", file ? `img:${file}` : "", attr, near ? `in:${near}` : ""]
    .filter((part) => part.length > 0)
    .map((part) => part.slice(0, 48))
    .join("; ");
}

// Snapshot v2: the accessibility tree kept with its containers, then rendered to a budget.
export const DEFAULT_BUDGET = 3000;
export const MAX_BUDGET = 30_000;
export const MIN_BUDGET = 500;
export const CLICKABLE_CAP = 40;
/** Skip the clickable scan when the accessibility tree is already this large. */
export const CLICKABLE_NODE_LIMIT = 2500;
export const CLICKABLE_MS = 30;
export const VIEW_CHAR_LIMIT = 40_000;

export type ExpandSection = "nav" | "footer" | "all";

export interface RenderOptions {
  budget: number;
  /** Lines that match are kept first; non-matching lines stay only as their containers. */
  focus?: string;
  /** Backend node ids that changed since the last pinned render. */
  delta?: Set<number>;
  expand?: ExpandSection[];
}

export interface TreeNode {
  axId: string;
  parentAxId?: string;
  backendNodeId?: number;
  ref?: string;
  frame?: string;
  role: string;
  name: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  focused?: boolean;
  expanded?: boolean;
  selected?: boolean;
  pressed?: boolean | "mixed";
  mixed?: boolean;
  hidden?: boolean;
  url?: string;
  required?: boolean;
  invalid?: string;
  placeholder?: string;
  offscreen?: boolean;
  options?: string[];
  /** A landmark, row, or other grouping node. Printed as a section, not as a control. */
  container?: boolean;
  /** Collected from the cursor/click scan, not from the accessibility tree. */
  clickable?: boolean;
}

export interface SemanticTree {
  url: string;
  title: string;
  nodes: TreeNode[];
}

export interface ClickableHit {
  text: string;
  selector: string;
  offscreen: boolean;
}

export interface ResolvedClickable {
  backendNodeId: number;
  text: string;
  offscreen?: boolean;
}

export interface PageScan {
  text: string;
  clickables: ClickableHit[];
  offscreen: string[];
}

export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "option",
  "treeitem",
  "listbox",
  "menuitemcheckbox",
  "menuitemradio",
]);

export const CONTAINER_ROLES = new Set([
  "dialog",
  "alertdialog",
  "form",
  "table",
  "row",
  "list",
  "listitem",
  "navigation",
  "main",
  "banner",
  "contentinfo",
  "region",
]);

export const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo"]);
export const TEXT_ROLES = new Set(["statictext", "paragraph"]);
export const CELL_ROLES = new Set(["cell", "gridcell", "columnheader", "rowheader"]);

export function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max) : text;
}

export function clampBudget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_BUDGET;
  return Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, Math.floor(value)));
}

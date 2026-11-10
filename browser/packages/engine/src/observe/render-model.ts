import { CELL_ROLES, CHROME_ROLES, TEXT_ROLES, clip, type TreeNode } from "./types.js";

export type Section =
  | "header"
  | "notice"
  | "dialog"
  | "focus"
  | "delta"
  | "control"
  | "heading"
  | "text"
  | "chrome"
  | "note";

export type Kind = "header" | "notice" | "container" | "control" | "heading" | "text" | "note";

export interface Line {
  key: string;
  parentKey?: string;
  order: number;
  depth: number;
  section: Section;
  kind: Kind;
  role: string;
  bareName: string;
  text: string;
  hay: string;
  row: boolean;
  table: boolean;
  id?: number;
  value?: string;
  token?: string;
}

export const RANK: Record<Section, number> = {
  header: 0,
  notice: 0,
  dialog: 1,
  focus: 2,
  delta: 3,
  control: 4,
  heading: 5,
  text: 6,
  chrome: 7,
  note: 8,
};

/** Drop nav and footer first, then text, and only then a control. */
export const DROP_ORDER: Section[] = [
  "note",
  "chrome",
  "text",
  "heading",
  "control",
  "delta",
  "focus",
  "dialog",
  "notice",
];

const ROLE_LABEL: Record<string, string> = {
  navigation: "nav",
  contentinfo: "footer",
  alertdialog: "dialog",
  listitem: "item",
};

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

export function pageHeading(url: string, title: string): string {
  const where = locationOf(url);
  const name = clip(title, 60);
  if (!name || name === where) return where || name || "(no page)";
  return `${where} · ${name}`;
}

function locationOf(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.host}${path}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

export function sameSitePath(pageUrl: string, href: string): string | undefined {
  try {
    const page = new URL(pageUrl);
    const link = new URL(href, pageUrl);
    if (link.origin !== page.origin) return undefined;
    return `${link.pathname}${link.search}${link.hash}`;
  } catch {
    return undefined;
  }
}

export function quote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function controlText(node: TreeNode, pageUrl: string, token: string): string {
  const name = node.name || node.placeholder || "";
  const parts = [`[${token}] ${node.role} ${quote(name)}`];
  if (node.value !== undefined) parts.push(` = ${showValue(node.value)}`);
  if (node.options?.length) parts.push(` ${optionSummary(node.options)}`);
  const path = node.url ? sameSitePath(pageUrl, node.url) : undefined;
  if (path) parts.push(` → ${path}`);
  parts.push(flagText(node));
  return parts.join("");
}

function showValue(value: string): string {
  return value.length > 0 && /^[^\s"]*$/.test(value) ? value : JSON.stringify(value);
}

function optionSummary(options: readonly string[]): string {
  const head = options.slice(0, 3).join(", ");
  const more = options.length > 3 ? `, +${options.length - 3}` : "";
  return `(${head}${more})`;
}

function flagText(node: TreeNode): string {
  const parts: string[] = [];
  for (const name of [
    "disabled",
    "checked",
    "focused",
    "expanded",
    "selected",
    "pressed",
    "mixed",
  ] as const) {
    const value = node[name];
    if (value !== undefined) parts.push(` ${name}=${String(value)}`);
  }
  if (node.required) parts.push(" required");
  if (node.invalid) parts.push(` invalid: ${quote(node.invalid)}`);
  if (node.offscreen) parts.push(" ↓");
  return parts.join("");
}

export function tableText(name: string, total: number, shown: number): string {
  const title = name ? `table "${clip(name, 60)}"` : "table";
  if (total < 1) return title;
  if (shown < total) return `${title} (${total} rows; ${shown} shown)`;
  return `${title} (${total} rows)`;
}

export function chromeText(node: TreeNode, links: number, buttons: number): string {
  const name = node.name ? ` "${clip(node.name, 60)}"` : "";
  const parts: string[] = [];
  if (links) parts.push(`${links} link${links === 1 ? "" : "s"}`);
  if (buttons) parts.push(`${buttons} button${buttons === 1 ? "" : "s"}`);
  const count = parts.length ? ` (${parts.join(", ")})` : "";
  return `${roleLabel(node.role)}${name}${count}`;
}

export function containerText(node: TreeNode): string {
  const label = roleLabel(node.role);
  return node.name ? `${label} "${clip(node.name, 60)}"` : label;
}

export function isDialogRole(role: string): boolean {
  return role === "dialog" || role === "alertdialog";
}

export function isChromeRole(role: string): boolean {
  return CHROME_ROLES.has(role);
}

export function isSkippableText(role: string): boolean {
  return TEXT_ROLES.has(role) || CELL_ROLES.has(role);
}

export function lineCost(line: Line): number {
  return line.depth * 2 + line.text.length;
}

export function paint(lines: readonly Line[]): string {
  return lines.map((line) => `${"  ".repeat(line.depth)}${line.text}`).join("\n");
}

export function cost(lines: readonly Line[]): number {
  if (!lines.length) return 0;
  return lines.reduce((sum, line) => sum + lineCost(line), 0) + (lines.length - 1);
}

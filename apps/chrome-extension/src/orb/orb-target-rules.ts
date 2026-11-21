// What the user pointed at when they summoned the cursor. Pure rules over a small element shape,
// so they can be tested without a page: the selection first, else the element under the pointer
// (skipping Aeon's own overlay, climbing at most 3 ancestors), else nothing.

export interface TargetRect {
  width: number;
  height: number;
}

export interface TargetNode {
  tagName: string;
  parentElement: TargetNode | null;
  childNodes: ArrayLike<{ nodeType: number; textContent: string | null }>;
  textContent: string | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getBoundingClientRect(): TargetRect;
}

export interface TargetPayload {
  /** A CSS selector for the element, or absent for a selection. */
  selector?: string;
  label: string;
  role?: string;
  tag?: string;
  /** Up to 200 characters of the element's text. Never its HTML. */
  text?: string;
}

const LABEL_MAX = 28;
const TEXT_MAX = 200;
const OWN_TEXT_MAX = 80;
const CLIMB = 3;
const REJECTED_TAGS = new Set(["HTML", "BODY", "MAIN", "SECTION", "ARTICLE", "IFRAME", "FRAME"]);
const INTERACTIVE_TAGS = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA"]);
const CONTENT_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "LI", "TR", "TD", "TH", "LABEL"]);
const ROLES = new Set(["button", "link", "tab", "checkbox", "option", "menuitem"]);

export function collapse(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Cut at 28 characters with an end ellipsis. */
export function truncateLabel(text: string, max = LABEL_MAX): string {
  const clean = collapse(text);
  return clean.length <= max ? clean : clean.slice(0, max - 1).trimEnd() + "…";
}

/** A selection of at least 2 non-space characters, in curly quotes. */
export function selectionLabel(text: string): { label: string; title: string } | undefined {
  const clean = collapse(text);
  if (clean.replace(/\s/g, "").length < 2) return undefined;
  return { label: "“" + truncateLabel(clean, LABEL_MAX - 2) + "”", title: clean.slice(0, 500) };
}

export function ownText(node: TargetNode): string {
  let text = "";
  for (const child of Array.from(node.childNodes))
    if (child.nodeType === 3) text += child.textContent ?? "";
  return collapse(text);
}

export function isOverlay(node: TargetNode | null): boolean {
  for (let current = node; current; current = current.parentElement)
    if (current.hasAttribute("data-aeon-overlay")) return true;
  return false;
}

function interactive(node: TargetNode): boolean {
  if (node.tagName === "A") return node.hasAttribute("href");
  if (INTERACTIVE_TAGS.has(node.tagName)) return true;
  return ROLES.has((node.getAttribute("role") ?? "").toLowerCase());
}

function contentLike(node: TargetNode): boolean {
  if (node.tagName === "IMG") return Boolean(node.getAttribute("alt")?.trim());
  if (CONTENT_TAGS.has(node.tagName)) return true;
  const own = ownText(node);
  return own.length >= 1 && own.length <= OWN_TEXT_MAX;
}

function rejected(node: TargetNode, viewport: TargetRect): boolean {
  if (REJECTED_TAGS.has(node.tagName)) return true;
  const box = node.getBoundingClientRect();
  if (box.width < 4 || box.height < 4) return true;
  if (box.width * box.height > 0.4 * viewport.width * viewport.height) return true;
  const plain = node.tagName === "DIV" || node.tagName === "SPAN";
  return plain && !ownText(node) && !node.getAttribute("role") && !node.getAttribute("aria-label");
}

export function acceptable(node: TargetNode, viewport: TargetRect): boolean {
  if (rejected(node, viewport)) return false;
  return interactive(node) || contentLike(node);
}

/** The element under the pointer: the top non-overlay hit, or one of its 3 nearest ancestors. */
export function pickTarget(
  stack: readonly TargetNode[],
  viewport: TargetRect,
): TargetNode | undefined {
  const hit = stack.find((node) => !isOverlay(node));
  let current: TargetNode | null | undefined = hit;
  for (let step = 0; current && step <= CLIMB; step += 1, current = current.parentElement)
    if (acceptable(current, viewport)) return current;
  return undefined;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function fieldName(node: TargetNode): string {
  const type = (node.getAttribute("type") ?? "").toLowerCase();
  if (node.tagName === "SELECT") return "Choice field";
  if (type && type !== "text") return capital(type) + " field";
  const name = collapse(node.getAttribute("name")).replace(/[_-]+/g, " ");
  return name ? capital(name) + " field" : "Text field";
}

/** aria-label, alt, own text, placeholder, then the field's type or name ("Search field"). */
export function elementLabel(node: TargetNode): string {
  const candidates = [
    node.getAttribute("aria-label"),
    node.getAttribute("alt"),
    ownText(node),
    node.getAttribute("placeholder"),
  ];
  const found = candidates.map(collapse).find(Boolean);
  if (found) return found;
  if (INTERACTIVE_TAGS.has(node.tagName)) return fieldName(node);
  return collapse(node.textContent) || node.tagName.toLowerCase();
}

const IMPLICIT_ROLE: Record<string, string> = {
  A: "link",
  BUTTON: "button",
  SELECT: "combobox",
  TEXTAREA: "textbox",
  INPUT: "textbox",
  IMG: "img",
  LI: "listitem",
  TR: "row",
  TD: "cell",
  TH: "columnheader",
};

export function roleOf(node: TargetNode): string | undefined {
  const explicit = collapse(node.getAttribute("role"));
  if (explicit) return explicit;
  if (/^H[1-6]$/.test(node.tagName)) return "heading";
  return IMPLICIT_ROLE[node.tagName];
}

export function targetPayload(node: TargetNode, selector: string | undefined): TargetPayload {
  const text = collapse(node.textContent).slice(0, TEXT_MAX);
  const role = roleOf(node);
  return {
    ...(selector ? { selector } : {}),
    label: elementLabel(node).slice(0, TEXT_MAX),
    ...(role ? { role } : {}),
    tag: node.tagName.toLowerCase(),
    ...(text ? { text } : {}),
  };
}

export interface FieldLike {
  tagName: string;
  type?: string;
  disabled?: boolean;
  offsetParent: unknown;
  getBoundingClientRect(): TargetRect;
}

const SKIPPED_INPUTS = new Set(["hidden", "submit", "button", "search", "reset", "image"]);

export function fillableField(field: FieldLike): boolean {
  if (field.disabled) return false;
  const tag = field.tagName;
  if (tag === "INPUT" && SKIPPED_INPUTS.has((field.type ?? "text").toLowerCase())) return false;
  if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return false;
  if (field.offsetParent === null) return false;
  const box = field.getBoundingClientRect();
  return box.width >= 4 && box.height >= 4;
}

/** A form with at least 3 visible, enabled fields: the "Fill form" starter shows. */
export function hasFillableForm(forms: readonly { fields: readonly FieldLike[] }[]): boolean {
  return forms.some((form) => form.fields.filter(fillableField).length >= 3);
}

import { CURSOR_TOKEN_CSS } from "@browserkit/engine/cursor-mark";
import {
  elementLabel,
  hasFillableForm,
  isOverlay,
  pickTarget,
  selectionLabel,
  targetPayload,
  truncateLabel,
  type TargetNode,
  type TargetPayload,
} from "./orb-target-rules.js";

// The content script's half of point-and-command. Until the cursor is summoned it keeps only the
// last pointer position (a passive listener, at most once a frame); nothing reads the page. On
// summon it reads the selection or the element under that point once, and draws a real outline
// around the element for a moment. Only the label, role, tag, a selector and up to 200 characters
// of text leave the page; never its HTML.

export interface SummonTarget {
  label: string;
  title: string;
  payload: TargetPayload;
  /** A selection draws nothing extra: it is visible already. */
  selection: boolean;
}

export interface SummonInfo {
  target?: SummonTarget;
  fillForm: boolean;
}

let pointer: { x: number; y: number } | undefined;
let latest: { x: number; y: number } | undefined;
let pending = false;
let element: Element | undefined;
const aeonHosts = new Set<Element>();

/** Aeon's own layers that carry no marker of their own (the page must not find them). */
export function skipHost(host: Element): void {
  aeonHosts.add(host);
}

export function trackPointer(): void {
  addEventListener(
    "pointermove",
    (event) => {
      latest = { x: event.clientX, y: event.clientY };
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        pointer = latest;
      });
    },
    { passive: true, capture: true },
  );
}

function selectionTarget(): SummonTarget | undefined {
  const selection = getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return undefined;
  const anchor = selection.anchorNode;
  const owner = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
  if (isOverlay(owner as TargetNode | null)) return undefined;
  const text = selection.toString();
  const labelled = selectionLabel(text);
  if (!labelled) return undefined;
  return {
    ...labelled,
    selection: true,
    payload: { label: labelled.title.slice(0, 200), text: labelled.title.slice(0, 200) },
  };
}

function step(node: Element): string {
  const tag = node.tagName.toLowerCase();
  const parent = node.parentElement;
  const same = parent ? [...parent.children].filter((child) => child.tagName === node.tagName) : [];
  return same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag;
}

/** A selector for the element: its id, or a short path from the nearest id (at most 5 steps). */
function cssPath(node: Element): string {
  const parts: string[] = [];
  for (let current: Element | null = node; current && parts.length < 5;) {
    if (current.id) {
      parts.unshift("#" + CSS.escape(current.id));
      break;
    }
    parts.unshift(step(current));
    current = current.parentElement;
  }
  return parts.join(" > ");
}

function pointedTarget(): SummonTarget | undefined {
  if (!pointer) return undefined;
  const stack = document
    .elementsFromPoint(pointer.x, pointer.y)
    .filter((node) => !aeonHosts.has(node)) as unknown as TargetNode[];
  const viewport = { width: innerWidth, height: innerHeight };
  const hit = pickTarget(stack, viewport) as unknown as Element | undefined;
  if (!hit) return undefined;
  element = hit;
  const full = elementLabel(hit as unknown as TargetNode);
  return {
    label: truncateLabel(full),
    title: full.slice(0, 500),
    selection: false,
    payload: targetPayload(hit as unknown as TargetNode, cssPath(hit)),
  };
}

function fillForm(): boolean {
  const forms = [...document.forms].map((form) => ({
    fields: [...form.elements].filter(
      (field): field is HTMLInputElement => field instanceof HTMLElement,
    ),
  }));
  return hasFillableForm(forms);
}

/** Read once, when the cursor is summoned. A new summon replaces the target. */
export function captureSummon(): SummonInfo {
  element = undefined;
  const target = selectionTarget() ?? pointedTarget();
  if (target && !target.selection) flashTarget(700);
  return { ...(target ? { target } : {}), fillForm: fillForm() };
}

export function dropTarget(): void {
  element = undefined;
  hideOutline();
}

let outline: { host: HTMLElement; box: HTMLElement } | undefined;
let fadeTimer = 0;

const OUTLINE_STYLE =
  CURSOR_TOKEN_CSS +
  ".box{position:fixed;pointer-events:none;box-sizing:border-box;border-radius:4px;" +
  "outline:1.5px solid var(--aeon-island-ring);outline-offset:1px;opacity:1;" +
  "transition:opacity 180ms cubic-bezier(.2,0,0,1)}.box.fade{opacity:0}" +
  "@media (prefers-reduced-motion: reduce){.box{transition:none}}";

function outlineLayer(): { host: HTMLElement; box: HTMLElement } {
  if (outline) return outline;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none";
  host.setAttribute("data-aeon-overlay", "");
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = OUTLINE_STYLE;
  const box = document.createElement("div");
  box.className = "box fade";
  shadow.append(style, box);
  document.documentElement.append(host);
  outline = { host, box };
  return outline;
}

/** Outlines the element; `ms` > 0 fades it out after that long, 0 keeps it (chip hover). */
export function flashTarget(ms: number): void {
  if (!element?.isConnected) return;
  const rect = element.getBoundingClientRect();
  const { box } = outlineLayer();
  Object.assign(box.style, {
    left: rect.left + "px",
    top: rect.top + "px",
    width: rect.width + "px",
    height: rect.height + "px",
  });
  clearTimeout(fadeTimer);
  box.classList.remove("fade");
  if (ms > 0) fadeTimer = window.setTimeout(hideOutline, ms);
}

export function hideOutline(): void {
  clearTimeout(fadeTimer);
  outline?.box.classList.add("fade");
}

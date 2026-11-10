// Visible text and non-semantic clickables share one evaluate. Clickables are capped and
// timed so a huge page cannot stall the snapshot; the accessibility tree still comes back.
import { send } from "../cdp/send.js";
import {
  CLICKABLE_CAP,
  CLICKABLE_MS,
  type ClickableHit,
  type PageScan,
  type ResolvedClickable,
} from "./types.js";

const SCAN = { clickables: true, cap: CLICKABLE_CAP, ms: CLICKABLE_MS, nodeLimit: 4000 };

export function emptyScan(): PageScan {
  return { text: "", clickables: [], offscreen: [] };
}

export async function readPageScan(debuggee: chrome.debugger.Debuggee): Promise<PageScan> {
  const contextId = await observeContext(debuggee);
  const isolated = contextId === undefined ? undefined : await evaluateScan(debuggee, contextId);
  if (isolated) return isolated;
  return (await evaluateScan(debuggee)) ?? emptyScan();
}

export async function resolveClickables(
  debuggee: chrome.debugger.Debuggee,
  hits: readonly ClickableHit[],
): Promise<ResolvedClickable[]> {
  if (!hits.length) return [];
  const ids = await backendIdsFor(
    debuggee,
    hits.map((hit) => hit.selector),
  );
  const resolved: ResolvedClickable[] = [];
  const used = new Set<number>();
  for (let index = 0; index < hits.length && resolved.length < CLICKABLE_CAP; index++) {
    const id = ids[index];
    const hit = hits[index];
    if (id === undefined || !hit || used.has(id)) continue;
    used.add(id);
    resolved.push({
      backendNodeId: id,
      text: hit.text.slice(0, 80),
      ...(hit.offscreen ? { offscreen: true } : {}),
    });
  }
  return resolved;
}

async function observeContext(debuggee: chrome.debugger.Debuggee): Promise<number | undefined> {
  const frames = (await send(debuggee, "Page.getFrameTree", undefined, {
    label: "observeContext",
  }).catch(() => undefined)) as { frameTree?: { frame?: { id?: string } } } | undefined;
  const frameId = frames?.frameTree?.frame?.id;
  if (!frameId) return undefined;
  const created = (await send(
    debuggee,
    "Page.createIsolatedWorld",
    { frameId, worldName: "browserkit-observe" },
    { label: "observeContext" },
  ).catch(() => undefined)) as { executionContextId?: number } | undefined;
  return created?.executionContextId;
}

async function evaluateScan(
  debuggee: chrome.debugger.Debuggee,
  contextId?: number,
): Promise<PageScan | undefined> {
  const result = (await send(
    debuggee,
    "Runtime.evaluate",
    {
      expression: scanExpression(),
      returnByValue: true,
      ...(contextId !== undefined ? { contextId } : {}),
    },
    { label: "evaluateScan", ms: 5_000 },
  ).catch(() => undefined)) as { result?: { value?: unknown } } | undefined;
  return result ? asScan(result.result?.value) : undefined;
}

function scanExpression(): string {
  const text = `(${collectVisibleText.toString()})()`;
  const extra = `(${collectClickables.toString()})(${JSON.stringify(SCAN)})`;
  const helpers = [
    pushRoot,
    textRegion,
    visibleLine,
    scanRoot,
    noteOffscreen,
    clickableOf,
    armed,
    outsideViewport,
    axRole,
    cssPath,
    stepOf,
  ]
    .map((fn) => fn.toString())
    .join("\n");
  return `(() => {\n${helpers}\nlet text = ""; let extra = { clickables: [], offscreen: [] }; try { text = ${text}; } catch (e) {}\ntry { extra = ${extra}; } catch (e) {}\nreturn { text: text, clickables: extra.clickables || [], offscreen: extra.offscreen || [] };\n})()`;
}

function asScan(value: unknown): PageScan {
  if (!value || typeof value !== "object") return emptyScan();
  const record = value as Record<string, unknown>;
  return {
    text: typeof record.text === "string" ? record.text.slice(0, 20000) : "",
    clickables: Array.isArray(record.clickables) ? record.clickables.slice(0, CLICKABLE_CAP).flatMap(asHit) : [],
    offscreen: Array.isArray(record.offscreen)
      ? record.offscreen.filter((item): item is string => typeof item === "string").slice(0, 80)
      : [],
  };
}

function asHit(value: unknown): ClickableHit[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (typeof record.text !== "string" || typeof record.selector !== "string") return [];
  const text = record.text.replace(/\s+/g, " ").trim().slice(0, 80);
  const selector = record.selector.slice(0, 300);
  if (!text || !selector) return [];
  return [{ text, selector, offscreen: record.offscreen === true }];
}

async function backendIdsFor(
  debuggee: chrome.debugger.Debuggee,
  selectors: readonly string[],
): Promise<(number | undefined)[]> {
  const group = `aeon-click-${crypto.randomUUID()}`;
  const ids: (number | undefined)[] = new Array(selectors.length);
  try {
    const objectId = await selectorArray(debuggee, selectors, group);
    if (!objectId) return ids;
    await describeArray(debuggee, objectId, ids);
    return ids;
  } finally {
    await send(
      debuggee,
      "Runtime.releaseObjectGroup",
      { objectGroup: group },
      { label: "backendIdsFor" },
    ).catch(() => undefined);
  }
}

async function selectorArray(
  debuggee: chrome.debugger.Debuggee,
  selectors: readonly string[],
  group: string,
): Promise<string | undefined> {
  const evaluated = (await send(
    debuggee,
    "Runtime.evaluate",
    {
      expression: `(${pickSelectors.toString()})(${JSON.stringify(selectors)})`,
      objectGroup: group,
    },
    { label: "selectorArray", ms: 5_000 },
  )) as { result?: { objectId?: string }; exceptionDetails?: unknown };
  if (evaluated.exceptionDetails) return undefined;
  return evaluated.result?.objectId;
}

async function describeArray(
  debuggee: chrome.debugger.Debuggee,
  objectId: string,
  ids: (number | undefined)[],
): Promise<void> {
  const properties = (await send(
    debuggee,
    "Runtime.getProperties",
    { objectId, ownProperties: true },
    { label: "describeArray" },
  )) as { result?: { name: string; value?: { objectId?: string } }[] };
  // One round trip for all of them: sequential describes cost a CDP hop per clickable.
  await Promise.all(
    (properties.result ?? []).map(async (property) => {
      if (!/^\d+$/.test(property.name) || !property.value?.objectId) return;
      const described = (await send(
        debuggee,
        "DOM.describeNode",
        { objectId: property.value.objectId },
        { label: "describeArray" },
      ).catch(() => ({}))) as { node?: { backendNodeId?: number } };
      if (described.node?.backendNodeId !== undefined)
        ids[Number(property.name)] = described.node.backendNodeId;
    }),
  );
}

function pickSelectors(selectors: string[]): (Element | null)[] {
  return selectors.map((selector) => {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  });
}

function collectVisibleText(): string {
  const roots: (Document | ShadowRoot)[] = [document];
  const lines: { text: string; region: number }[] = [];
  const visible = new WeakMap<Element, boolean>();
  let length = 0;
  for (let index = 0; index < roots.length && length < 20000; index++) {
    const root = roots[index];
    if (!root) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && length < 20000; node = walker.nextNode()) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        pushRoot(node as Element, roots);
        continue;
      }
      const text = visibleLine(node, visible);
      if (text) {
        lines.push({ text, region: textRegion(node.parentElement) });
        length += text.length + 1;
      }
    }
  }
  return lines
    .map((line, index) => ({ ...line, index }))
    .sort((a, b) => a.region - b.region || a.index - b.index)
    .map((line) => line.text)
    .join("\n")
    .slice(0, 20000);
}

function pushRoot(element: Element, roots: (Document | ShadowRoot)[]): void {
  if (element.shadowRoot) roots.push(element.shadowRoot);
  if (element instanceof HTMLIFrameElement && element.contentDocument) roots.push(element.contentDocument);
}

function textRegion(element: Element | null): number {
  if (element?.closest("main,[role=main]")) return 0;
  if (element?.closest("footer,[role=contentinfo]")) return 3;
  if (element?.closest("header,nav,aside,[role=banner],[role=navigation],[role=complementary]")) return 2;
  return 1;
}

function visibleLine(node: Node, visible: WeakMap<Element, boolean>): string {
  let element = node.parentElement;
  const text = node.textContent?.replace(/\s+/g, " ").trim();
  if (!element || !text || element.closest("script,style,noscript,[data-aeon-overlay]")) return "";
  while (element.parentElement && getComputedStyle(element).display === "contents") element = element.parentElement;
  if (!visible.has(element)) {
    visible.set(element, element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  }
  return visible.get(element) ? text : "";
}

function collectClickables(options: { clickables: boolean; cap: number; ms: number; nodeLimit: number }): {
  clickables: { text: string; selector: string; offscreen: boolean }[];
  offscreen: string[];
} {
  const clickables: { text: string; selector: string; offscreen: boolean }[] = [];
  const offscreen: string[] = [];
  if (!options.clickables || document.getElementsByTagName("*").length > options.nodeLimit) {
    return { clickables, offscreen };
  }
  const started = Date.now();
  const taken: Element[] = [];
  const roots: ParentNode[] = [document];
  for (let index = 0; index < roots.length && Date.now() - started <= options.ms; index++) {
    scanRoot(roots[index], roots, options, started, taken, clickables, offscreen);
  }
  return { clickables, offscreen: offscreen.slice(0, 80) };
}

function scanRoot(
  root: ParentNode | undefined,
  roots: ParentNode[],
  options: { cap: number; ms: number },
  started: number,
  taken: Element[],
  clickables: { text: string; selector: string; offscreen: boolean }[],
  offscreen: string[],
): void {
  if (!root) return;
  for (const el of root.querySelectorAll("*")) {
    if (Date.now() - started > options.ms || clickables.length >= options.cap) return;
    if (el.shadowRoot) roots.push(el.shadowRoot);
    noteOffscreen(el, offscreen);
    const hit = clickableOf(el, taken);
    if (hit) clickables.push(hit);
  }
}

function noteOffscreen(el: Element, offscreen: string[]): void {
  if (offscreen.length >= 80) return;
  const role = axRole(el);
  const name = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
  if (!role || !name || !outsideViewport(el)) return;
  offscreen.push(`${role}|${name.slice(0, 80)}`);
}

function clickableOf(
  el: Element,
  taken: Element[],
): { text: string; selector: string; offscreen: boolean } | null {
  if (taken.some((node) => node.contains(el)) || !armed(el)) return null;
  const text = (el.getAttribute("aria-label") || (el as HTMLElement).innerText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (!text) return null;
  taken.push(el);
  return { text, selector: cssPath(el), offscreen: outsideViewport(el) };
}

function armed(el: Element): boolean {
  const selector =
    "a,button,input,select,textarea,summary,[role='button'],[role='link'],[role='textbox'],[role='checkbox'],[role='radio'],[role='switch'],[role='tab'],[role='menuitem'],[role='combobox']";
  if (el.tagName === "BODY" || el.tagName === "HTML" || el.closest("[data-aeon-overlay]")) return false;
  if (el.matches(selector) || el.parentElement?.closest(selector)) return false;
  const style = getComputedStyle(el);
  const box = el.getBoundingClientRect();
  if (box.width < 8 || box.height < 8) return false;
  if (box.width > innerWidth * 0.9 && box.height > innerHeight * 0.5) return false;
  const handler = (el as HTMLElement).onclick;
  return style.cursor === "pointer" || el.hasAttribute("onclick") || typeof handler === "function";
}

function outsideViewport(el: Element): boolean {
  const box = el.getBoundingClientRect();
  return box.width > 0 && (box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth);
}

function axRole(el: Element): string {
  const role = el.getAttribute("role");
  if (role) return role.toLowerCase();
  if (el.tagName === "A") return "link";
  if (el.tagName === "BUTTON") return "button";
  if (el.tagName === "SELECT") return "combobox";
  if (el.tagName === "TEXTAREA") return "textbox";
  if (el.tagName !== "INPUT") return "";
  const type = el instanceof HTMLInputElement ? el.type : "";
  if (type === "checkbox") return "checkbox";
  if (type === "radio") return "radio";
  return "textbox";
}

function cssPath(el: Element): string {
  if (el.id && /^[A-Za-z][\w:-]*$/.test(el.id)) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && parts.length < 5) {
    parts.unshift(stepOf(node));
    node = node.parentElement;
  }
  return parts.join(" > ");
}

function stepOf(node: Element): string {
  const tag = node.tagName.toLowerCase();
  const siblings = node.parentElement
    ? [...node.parentElement.children].filter((child) => child.tagName === node.tagName)
    : [];
  if (siblings.length < 2) return tag;
  return `${tag}:nth-of-type(${siblings.indexOf(node) + 1})`;
}

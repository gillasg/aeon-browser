// Tier 0: page reads without the debugger. A read-only step (page.read, markdown, text, data,
// metadata, page.request) runs as an isolated-world chrome.scripting.executeScript on the tab, so
// a run that only reads never attaches chrome.debugger and Chrome never shows its debugging bar.
// The readers are the same functions the sandbox realm sends to Runtime.evaluate (page-readers.ts),
// recognised by their exact source, so both paths run identical code. Anything else, a tab whose
// debugger is already attached (CDP is then free), a restricted page, or a frame slower than the
// cap, returns undefined and the caller takes the CDP path.
//
// Page provenance (invariant I-3): page.request() is a fetch from the isolated world of a live tab
// on that origin. Chrome sends it as the page's own request: its cookies, Origin and Referer,
// Sec-Fetch-* headers, HTTP/2 connection and TLS session. It is never a service-worker fetch.
import {
  __expandRead,
  __pageRequest,
  __readMarkdown,
  __readMetadata,
  __readPageData,
  __waitRead,
} from "./page-readers.js";

/** A frame that has not answered within this is slow: the step goes to CDP instead. */
export const SLOW_FRAME_MS = 2_500;

type PageFunc = (...args: never[]) => unknown;
interface Plan {
  steps: { func: PageFunc; args: (prior: unknown) => unknown[] }[];
  capMs: number;
}

const tiny: Record<string, PageFunc> = {
  "(() => document.title)()": () => document.title,
  "(() => location.href)()": () => location.href,
  "location.origin": () => location.origin,
  "location.href": () => location.href,
};

function call(func: PageFunc, tail: string): string {
  return `(${func.toString()})(${tail}`;
}

/** Parses `JSON)` at the end of a reader call; undefined when it is not plain JSON. */
function argOf(expression: string, prefix: string): unknown {
  if (!expression.startsWith(prefix) || !expression.endsWith(")")) return undefined;
  const text = expression.slice(prefix.length, -1);
  try {
    return text === "" ? {} : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function single(func: PageFunc, arg: unknown, capMs = SLOW_FRAME_MS): Plan {
  return { steps: [{ func, args: () => [arg] as unknown[] }], capMs };
}

function waitCap(arg: unknown): number {
  const maxMs = Number((arg as { maxMs?: unknown } | null)?.maxMs) || 5_000;
  return Math.min(5_000, Math.max(200, maxMs)) + SLOW_FRAME_MS;
}

/** The debugger-free plan for an evaluate expression, or undefined when it needs CDP. */
export function tier0Plan(expression: string): Plan | undefined {
  const exact = tiny[expression.trim()];
  if (exact) return single(exact, undefined);
  if (expression === `(${__readMetadata.toString()})()`) return single(__readMetadata, undefined);
  const dataPrefix = `(${__readPageData.toString()})(${__readMetadata.toString()}, `;
  const data = argOf(expression, dataPrefix);
  if (data !== undefined)
    return {
      steps: [
        { func: __readMetadata, args: () => [] },
        { func: __readPageData, args: (meta) => [meta, data] },
      ],
      capMs: SLOW_FRAME_MS,
    };
  const readers: [PageFunc, (arg: unknown) => number][] = [
    [__readMarkdown, () => SLOW_FRAME_MS],
    [__expandRead, () => SLOW_FRAME_MS],
    [__waitRead, waitCap],
    // A network round trip, not a frame walk: its own longer cap.
    [__pageRequest, () => 30_000],
  ];
  for (const [func, cap] of readers) {
    const arg = argOf(expression, call(func, ""));
    if (arg !== undefined) return single(func, arg, cap(arg));
  }
  return undefined;
}

/** Whether the tab can be read without the debugger: a web page whose debugger is not attached. */
export async function tier0Eligible(tabId: number, attached: boolean): Promise<boolean> {
  if (attached || !chrome.scripting?.executeScript) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  return /^https?:/i.test(tab?.url ?? "");
}

class SlowFrame extends Error {}

async function runOne(tabId: number, func: PageFunc, args: unknown[], capMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: "ISOLATED",
        func: func as (...a: unknown[]) => unknown,
        args,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SlowFrame("slow frame")), capMs);
      }),
    ]);
    const first = results[0] as { result?: unknown; error?: unknown } | undefined;
    if (!first || first.error !== undefined) throw new SlowFrame("no result");
    return first.result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs a plan in the isolated world; undefined means "use CDP". */
export async function runTier0(tabId: number, plan: Plan): Promise<{ value: unknown } | undefined> {
  try {
    let prior: unknown;
    for (const step of plan.steps)
      prior = await runOne(tabId, step.func, step.args(prior), plan.capMs);
    return { value: prior };
  } catch {
    return undefined;
  }
}

/** page.read(selector): elements by selector across the document and every shadow root. */
export async function tier0Extract(
  tabId: number,
  selector: string,
  limit: number,
  textLimit: number,
  attributes: string[],
): Promise<unknown> {
  const done = await runTier0(tabId, {
    steps: [
      {
        func: extractDeep as PageFunc,
        args: () => [selector, limit, textLimit, attributes, SLOW_FRAME_MS],
      },
    ],
    capMs: SLOW_FRAME_MS + 250,
  });
  return done?.value;
}

/**
 * Runs in the page's isolated world. chrome.dom.openOrClosedShadowRoot reaches closed shadow roots
 * too; a page whose tree takes longer than capMs to walk stops there and says partial.
 */
export function extractDeep(
  selector: string,
  limit: number,
  textLimit: number,
  attributes: string[],
  capMs: number,
): unknown {
  const deadline = Date.now() + capMs;
  const shadowOf = (element: Element): ShadowRoot | null => {
    try {
      const dom = (globalThis as { chrome?: { dom?: typeof chrome.dom } }).chrome?.dom;
      return dom?.openOrClosedShadowRoot?.(element as HTMLElement) ?? element.shadowRoot;
    } catch {
      return element.shadowRoot;
    }
  };
  const found: Element[] = [];
  let partial = false;
  const walk = (root: Document | ShadowRoot): void => {
    for (const element of Array.from(root.querySelectorAll(selector))) found.push(element);
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (Date.now() > deadline) {
        partial = true;
        return;
      }
      const inner = shadowOf(element);
      if (inner) walk(inner);
      if (partial) return;
    }
  };
  walk(document);
  const text = (element: Element) =>
    ((element as HTMLElement).innerText ?? element.textContent ?? "").trim().slice(0, textLimit);
  return {
    count: found.length,
    truncated: found.length > limit,
    ...(partial ? { partial: true } : {}),
    items: found.slice(0, limit).map((element) => ({
      text: text(element),
      attributes: Object.fromEntries(
        attributes.map((name) => [name, element.getAttribute(name)?.slice(0, textLimit) ?? null]),
      ),
    })),
  };
}

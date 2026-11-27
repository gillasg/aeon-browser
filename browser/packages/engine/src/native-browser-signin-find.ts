import { send } from "./cdp/send.js";
import { discoverFrames, evaluateFrame } from "./native-browser-frames.js";
import { withBrowserDebugger } from "./native-browser-session.js";

// Where a sign-in form lives. Many sites put it in an open shadow root (a web component) or an
// iframe. The page-side finder walks the document, every open shadow root and every same-origin
// frame. A frame of another origin cannot be reached from the page, so it is entered through its
// own frame (its CDP frame target); it is used only when it belongs to the same site as the tab,
// so a login is never typed into another site's frame. The frame a form was found in is kept per
// tab, and every later step (focus, click, clear) runs there.

export const MARK = "data-signin-field";

/** Page-side helpers: every root (document, open shadow roots, same-origin frames) and a deep find. */
export const DEEP = `
  const roots = (start) => {
    const found = [start];
    for (let index = 0; index < found.length; index++) {
      for (const el of found[index].querySelectorAll("*")) {
        if (el.shadowRoot) found.push(el.shadowRoot);
        if (/^(IFRAME|FRAME)$/.test(el.tagName)) { try { if (el.contentDocument && el.contentDocument.documentElement) found.push(el.contentDocument); } catch {} }
      }
    }
    return found;
  };
  const all = (selector) => roots(document).flatMap((root) => [...root.querySelectorAll(selector)]);
  const one = (selector) => all(selector)[0] || null;
`;

const NO_FRAME = { frameId: "", sessionId: undefined as string | undefined };
type FormFrame = typeof NO_FRAME;
const formFrames = new Map<number, FormFrame>();

/** Runs an expression in the tab's top document. */
export async function evaluate(tabId: number, expression: string): Promise<unknown> {
  const result = await withBrowserDebugger(tabId, (debuggee) =>
    send(
      debuggee,
      "Runtime.evaluate",
      { expression, returnByValue: true, silent: true },
      { label: "evaluate", ms: 5_000 },
    ),
  );
  return (result as { result?: { value?: unknown } } | undefined)?.result?.value;
}

async function evaluateIn(tabId: number, frame: FormFrame, expression: string): Promise<unknown> {
  if (!frame.frameId) return evaluate(tabId, expression);
  return withBrowserDebugger(tabId, (debuggee) =>
    evaluateFrame(
      { ...debuggee, ...(frame.sessionId ? { sessionId: frame.sessionId } : {}) },
      frame.frameId,
      expression,
    ),
  );
}

/** Runs an expression where the tab's sign-in form was last found (the top document by default). */
export function evaluateForm(tabId: number, expression: string): Promise<unknown> {
  return evaluateIn(tabId, formFrames.get(tabId) ?? NO_FRAME, expression);
}

/** The site a host belongs to (example.co.uk for login.example.co.uk), as the page finder says. */
export function siteOfHost(host: string): string {
  const parts = host.replace(/^www[.]/, "").split(".");
  const last = parts[parts.length - 1] ?? "";
  const second = parts[parts.length - 2] ?? "";
  const n =
    parts.length >= 3 && last.length === 2 && /^(co|com|org|net|ac|gov|edu)$/.test(second) ? 3 : 2;
  return parts.slice(-n).join(".");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

interface Scanned {
  user?: boolean;
  password?: boolean;
  code?: boolean;
  captcha?: boolean;
  url?: string;
  foreign?: string;
}
const hasFields = (value: Scanned | undefined): boolean =>
  Boolean(value && (value.user || value.password || value.code));

async function childFrames(tabId: number): Promise<Array<FormFrame & { url: string }>> {
  const frames = await withBrowserDebugger(tabId, (debuggee) => discoverFrames(debuggee)).catch(
    () => [],
  );
  return frames
    .filter((frame) => frame.parentFrameId && /^https?:/.test(frame.url))
    .map((frame) => ({ frameId: frame.frameId, sessionId: frame.sessionId, url: frame.url }));
}

/**
 * Scans the top document (which reaches open shadow roots and same-origin frames), then each
 * cross-origin frame. A form in a frame of another site is reported as foreign: nothing is typed.
 */
export async function scanDeep<T extends Scanned>(
  tabId: number,
  expression: string,
): Promise<T | undefined> {
  const top = (await evaluate(tabId, expression).catch(() => undefined)) as T | undefined;
  formFrames.delete(tabId);
  if (!top || typeof top !== "object" || hasFields(top) || top.captcha) return top;
  const topSite = siteOfHost(hostOf(top.url ?? ""));
  for (const frame of await childFrames(tabId)) {
    const found = (await evaluateIn(tabId, frame, expression).catch(() => undefined)) as
      T | undefined;
    if (!found || typeof found !== "object" || !hasFields(found)) continue;
    const host = hostOf(frame.url);
    if (siteOfHost(host) !== topSite) return { ...found, foreign: host };
    formFrames.set(tabId, frame);
    return found;
  }
  return top;
}

/** Forgets the frame a tab's form was found in (the sign-in is over). */
export function forgetFormFrame(tabId: number): void {
  formFrames.delete(tabId);
}

const ERROR_WORDS =
  /incorrect|invalid|wrong|error|failed|try again|not recogni[sz]ed|doesn.?t match|does not match|couldn.?t|could not|locked|too many|no account|not found|required/i;

/** Before a submit: tags the document, and notes the error-looking lines already showing. */
const SUBMIT_MARK = `(() => {
  ${DEEP}
  document.documentElement.setAttribute("data-signin-submit", "1");
  const lines = roots(document).flatMap((root) => String((root.body || root.host || root).innerText || "").split("\\n"));
  const alerts = all('[role=alert], [aria-live], .error, .alert').map((el) => el.innerText || "");
  return { url: location.href, lines: [...lines, ...alerts].map((line) => line.trim()).filter((line) => ${ERROR_WORDS}.test(line)).slice(0, 50) };
})()`;

export interface SubmitMark {
  url: string;
  lines: string[];
}

export async function markSubmit(tabId: number): Promise<SubmitMark | undefined> {
  const value = (await evaluateForm(tabId, SUBMIT_MARK).catch(() => undefined)) as
    SubmitMark | undefined;
  return value && typeof value === "object" ? value : undefined;
}

const SUBMIT_CHECK = `(() => {
  const mark = ${SUBMIT_MARK.replace('document.documentElement.setAttribute("data-signin-submit", "1");', "")};
  return { ...mark, same: document.documentElement.getAttribute("data-signin-submit") === "1" };
})()`;

/**
 * Whether the page reacted to the submit: a new document, a new address, or a new error line.
 * Unknown (the page could not be read) counts as reacted, so no false SUBMIT_NO_EFFECT.
 */
export async function submitReacted(tabId: number, before: SubmitMark): Promise<boolean> {
  const after = (await evaluateForm(tabId, SUBMIT_CHECK).catch(() => undefined)) as
    (SubmitMark & { same: boolean }) | undefined;
  if (!after || typeof after !== "object" || !after.same || after.url !== before.url) return true;
  const known = new Set(before.lines);
  return after.lines.some((line) => !known.has(line));
}

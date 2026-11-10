// A silent click is a miss. clickAt is the next call only when this node has no handler and a
// child does (a card whose link is the child). Otherwise the next call stays a state read.
import { onNode } from "./native-browser-dom.js";

function childClickPoint(this: HTMLElement): { x: number; y: number } | null {
  const listens = (el: Element) =>
    el.tagName === "A" ||
    el.tagName === "BUTTON" ||
    el.hasAttribute("onclick") ||
    typeof (el as HTMLElement).onclick === "function";
  if (listens(this)) return null;
  const child = [...this.querySelectorAll("a,button,[onclick]")].find((el) => listens(el));
  if (!child) return null;
  const box = child.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return null;
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/** The child's viewport point, or undefined when this node itself is the handler. */
export async function childHandlerPoint(
  debuggee: chrome.debugger.Debuggee,
  backendNodeId: number,
): Promise<{ x: number; y: number } | undefined> {
  const point = await onNode<{ x: number; y: number } | null>(
    debuggee,
    backendNodeId,
    childClickPoint,
  ).catch(() => null);
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
  if (point.x < 0 || point.y < 0) return undefined;
  return { x: point.x, y: point.y };
}

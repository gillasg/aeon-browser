import { onNode, nodeState, fillTextNode } from "./native-browser-dom.js";
interface Point {
  x: number;
  y: number;
}
export async function actionablePoint(
  debuggee: chrome.debugger.Debuggee,
  id: number,
  editable = false,
): Promise<Point> {
  await chrome.debugger.sendCommand(debuggee, "DOM.scrollIntoViewIfNeeded", { backendNodeId: id });
  const state = await onNode<{ visible: boolean; enabled: boolean; editable: boolean }>(
    debuggee,
    id,
    nodeState,
  );
  if (!state.visible) throw new Error("TARGET_HIDDEN");
  if (!state.enabled) throw new Error("TARGET_DISABLED");
  if (editable && !state.editable) throw new Error("NOT_EDITABLE");
  let prior: Point | undefined;
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await onNode<Point & { hit: boolean }>(debuggee, id, hitPoint);
    const stable = prior && Math.abs(current.x - prior.x) < 1 && Math.abs(current.y - prior.y) < 1;
    if (stable && current.hit) return { x: current.x, y: current.y };
    prior = current;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("TARGET_BLOCKED");
}
function hitPoint(this: HTMLElement) {
  const box = this.getBoundingClientRect();
  const left = Math.max(0, box.left),
    top = Math.max(0, box.top);
  const right = Math.min(innerWidth, box.right),
    bottom = Math.min(innerHeight, box.bottom);
  const x = (left + right) / 2,
    y = (top + bottom) / 2;
  const root = this.getRootNode() as Document | ShadowRoot;
  const hit = root.elementFromPoint(x, y);
  let offsetX = 0,
    offsetY = 0,
    current: Window = window;
  while (current !== current.parent) {
    const frame = current.frameElement;
    if (!frame) return { x, y, hit: false };
    const rect = frame.getBoundingClientRect();
    offsetX += rect.left + (frame as HTMLElement).clientLeft;
    offsetY += rect.top + (frame as HTMLElement).clientTop;
    current = current.parent;
  }
  return {
    x: x + offsetX,
    y: y + offsetY,
    hit: right > left && bottom > top && !!hit && (hit === this || this.contains(hit)),
  };
}
export async function fillNode(
  debuggee: chrome.debugger.Debuggee,
  id: number,
  value: string,
): Promise<void> {
  const native = await onNode<string>(debuggee, id, setNativeValue, [value]);
  if (native === "done") return;
  if (native !== "text") throw new Error(native);
  await fillTextNode(debuggee, id, value);
}
function setNativeValue(this: HTMLInputElement | HTMLSelectElement, value: string): string {
  if (this instanceof HTMLSelectElement) {
    const options = [...this.options].filter((option) => !option.disabled);
    const normalize = (text: string) => text.trim().toLowerCase();
    let matches = options.filter(
      (option) =>
        normalize(option.value) === normalize(value) || normalize(option.text) === normalize(value),
    );
    if (!matches.length)
      matches = options.filter((option) => normalize(option.text).startsWith(normalize(value)));
    if (matches.length !== 1) return matches.length ? "AMBIGUOUS_TARGET" : "TARGET_NOT_FOUND";
    const match = matches[0];
    if (!match) return "TARGET_NOT_FOUND";
    this.value = match.value;
  } else if (
    this instanceof HTMLInputElement &&
    ["date", "time", "datetime-local", "month", "week", "number", "range", "color"].includes(
      this.type,
    )
  ) {
    const before = this.value;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(this, value);
    if (this.value !== value) {
      setter?.call(this, before);
      return "INPUT_FAILED";
    }
  } else return "text";
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return "done";
}
export async function focusNode(debuggee: chrome.debugger.Debuggee, id: number): Promise<void> {
  const focused = await onNode<boolean>(debuggee, id, function (this: HTMLElement) {
    this.focus({ preventScroll: true });
    return (this.getRootNode() as Document | ShadowRoot).activeElement === this;
  });
  if (!focused) throw new Error("INVALID_TARGET");
}
const keys: Record<string, [string, number, string?]> = {
  Enter: ["Enter", 13, "\r"],
  Tab: ["Tab", 9],
  Escape: ["Escape", 27],
  Backspace: ["Backspace", 8],
  Delete: ["Delete", 46],
  ArrowUp: ["ArrowUp", 38],
  ArrowDown: ["ArrowDown", 40],
  ArrowLeft: ["ArrowLeft", 37],
  ArrowRight: ["ArrowRight", 39],
  Home: ["Home", 36],
  End: ["End", 35],
  Space: ["Space", 32, " "],
};
export async function pressKey(debuggee: chrome.debugger.Debuggee, key: string): Promise<void> {
  const entry = keys[key];
  if (!entry) throw new Error("INVALID_TARGET");
  const [code, windowsVirtualKeyCode, text] = entry;
  const event = { key: key === "Space" ? " " : key, code, windowsVirtualKeyCode };
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown",
    ...event,
    ...(text ? { text, unmodifiedText: text } : {}),
  });
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
    type: "keyUp",
    ...event,
  });
}

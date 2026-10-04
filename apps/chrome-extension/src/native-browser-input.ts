import { onNode, nodeState } from "./native-browser-dom.js";
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
  return {
    x,
    y,
    hit: right > left && bottom > top && !!hit && (hit === this || this.contains(hit)),
  };
}
export async function fillNode(
  debuggee: chrome.debugger.Debuggee,
  id: number,
  value: string,
): Promise<void> {
  const focused = await onNode<boolean>(debuggee, id, selectInput);
  if (!focused) throw new Error("NOT_EDITABLE");
  if (value) await chrome.debugger.sendCommand(debuggee, "Input.insertText", { text: value });
  else await pressKey(debuggee, "Backspace");
  const actual = await onNode<string>(debuggee, id, inputValue);
  if (actual !== value) throw new Error("INPUT_FAILED");
}
function selectInput(this: HTMLInputElement | HTMLTextAreaElement) {
  this.focus({ preventScroll: true });
  const root = this.getRootNode() as Document | ShadowRoot;
  if (root.activeElement !== this) return false;
  if (this.isContentEditable) {
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(this);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return true;
  }
  if (!this.matches("input:not([readonly]),textarea:not([readonly])")) return false;
  try {
    this.select();
    return true;
  } catch {
    return false;
  }
}
function inputValue(this: HTMLInputElement | HTMLTextAreaElement) {
  return this.isContentEditable ? this.innerText : this.value;
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

import type { BrowserExecutorRequest } from "@browserkit/protocol";
import { send } from "./cdp/send.js";
import { showAgentCursor } from "./native-browser-cursor.js";
import { pointerButtonBits, pointerPress } from "./native-browser-debugger.js";
import { dragPath, humanMouse } from "./native-browser-human-input.js";
import { withFocusEmulation } from "./native-browser-session.js";

type PointerStep = Extract<BrowserExecutorRequest["step"], { op: "pointer" }>;
type MouseSend = (
  type: string,
  x: number,
  y: number,
  extra?: Record<string, unknown>,
) => Promise<unknown>;

/** A coordinate click, double-click, hover or drag, with the step's button and modifiers. */
export async function dispatchPointer(
  debuggee: chrome.debugger.Debuggee,
  step: PointerStep,
): Promise<unknown> {
  const held = heldModifiers(step);
  const mouse: MouseSend = async (type, x, y, extra = {}) => {
    const params = await humanMouse(debuggee, type, { x, y, ...extra });
    return send(
      debuggee,
      "Input.dispatchMouseEvent",
      { type, ...params },
      { label: "executeInteraction" },
    );
  };
  if (step.action === "drag" && step.toX !== undefined && step.toY !== undefined)
    showAgentCursor(debuggee, step.toX, step.toY, false, {
      from: { x: step.x, y: step.y },
      transient: true,
      caption: "Dragging",
    });
  else
    showAgentCursor(debuggee, step.x, step.y, step.action !== "hover", {
      transient: true,
      caption: step.action === "hover" ? "Hovering" : "Clicking",
    });
  // The whole gesture, including its landing move, runs while the tab is focus-emulated.
  // On macOS an Input.dispatchMouseEvent sent after a previous click turned focus emulation off
  // is never answered: the browser waits for the window to be key. Keeping the move inside the
  // same focus window as the press makes every click, hover and drag independent of tab focus.
  return withFocusEmulation(debuggee.tabId, async () => {
    await mouse("mouseMoved", step.x, step.y, held);
    if (step.action === "hover") return { hovered: true };
    return pressPointer(debuggee, step, mouse);
  });
}

function heldModifiers(step: {
  modifiers?: readonly string[] | undefined;
}): Record<string, unknown> {
  const modifiers = pointerPress(step).modifiers;
  return modifiers ? { modifiers } : {};
}

async function pressPointer(
  debuggee: chrome.debugger.Debuggee,
  step: PointerStep,
  mouse: MouseSend,
): Promise<unknown> {
  const held = heldModifiers(step);
  if (step.action === "drag") return dragPointer(debuggee, step, mouse, held);
  const button = pointerPress(step).button ?? "left";
  const down = pointerButtonBits[button];
  const count = step.action === "doubleClick" ? 2 : 1;
  for (let click = 1; click <= count; click++) {
    await mouse("mousePressed", step.x, step.y, {
      button,
      buttons: down,
      clickCount: click,
      ...held,
    });
    await mouse("mouseReleased", step.x, step.y, {
      button,
      buttons: 0,
      clickCount: click,
      ...held,
    });
  }
  return { clicked: true };
}

type DragData = Record<string, unknown>;

/** Collects the drag data Chrome hands back when it intercepts a native HTML5 drag on the tab. */
function watchDragIntercept(tabId: number | undefined): {
  data: () => DragData | undefined;
  stop: () => void;
} {
  let captured: DragData | undefined;
  const onEvent = chrome.debugger.onEvent as typeof chrome.debugger.onEvent | undefined;
  const listener = (source: chrome.debugger.Debuggee, method: string, params?: object): void => {
    if (source.tabId !== tabId || method !== "Input.dragIntercepted") return;
    captured = (params as { data?: DragData } | undefined)?.data ?? {};
  };
  onEvent?.addListener(listener);
  return { data: () => captured, stop: () => onEvent?.removeListener(listener) };
}

async function setInterceptDrags(
  debuggee: chrome.debugger.Debuggee,
  enabled: boolean,
): Promise<boolean> {
  try {
    await send(debuggee, "Input.setInterceptDrags", { enabled }, { label: "executeInteraction" });
    return true;
  } catch {
    return false;
  }
}

/** Replays an intercepted HTML5 drag onto the target; false when Chrome refuses the drop. */
async function replayDrop(
  debuggee: chrome.debugger.Debuggee,
  step: PointerStep,
  data: DragData,
): Promise<boolean> {
  try {
    for (const type of ["dragEnter", "dragOver", "drop"])
      await send(
        debuggee,
        "Input.dispatchDragEvent",
        { type, x: step.toX, y: step.toY, data },
        { label: "executeInteraction" },
      );
    return true;
  } catch {
    return false;
  }
}

/**
 * Press, travel and release. With drag interception on, a native HTML5 drag (draggable=true)
 * hands its data back instead of starting an OS drag the synthetic mouse can never finish, and
 * the drop is replayed at the target; pointer-only drags (no intercept) finish on the mouse path.
 */
async function dragPointer(
  debuggee: chrome.debugger.Debuggee,
  step: PointerStep,
  mouse: MouseSend,
  held: Record<string, unknown>,
): Promise<{ dragged: boolean; html5: boolean }> {
  if (step.toX === undefined || step.toY === undefined) throw new Error("INVALID_TARGET");
  const watch = watchDragIntercept(debuggee.tabId);
  const intercepting = await setInterceptDrags(debuggee, true);
  let dropped: boolean | undefined;
  try {
    await mouse("mousePressed", step.x, step.y, {
      button: "left",
      buttons: 1,
      clickCount: 1,
      ...held,
    });
    try {
      // A curved, slightly jittered path: a straight evenly spaced line is a synthetic tell, and
      // drop targets that track pointermove need intermediate points to register a hover.
      for (const point of dragPath({ x: step.x, y: step.y }, { x: step.toX, y: step.toY }))
        await mouse("mouseMoved", point.x, point.y, { button: "left", buttons: 1, ...held });
      const data = watch.data();
      if (data) dropped = await replayDrop(debuggee, step, data);
    } finally {
      await mouse("mouseReleased", step.toX, step.toY, {
        button: "left",
        buttons: 0,
        clickCount: 1,
        ...held,
      });
    }
  } finally {
    watch.stop();
    if (intercepting) await setInterceptDrags(debuggee, false);
  }
  return { dragged: dropped ?? true, html5: dropped !== undefined };
}

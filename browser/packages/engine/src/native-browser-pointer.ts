import type { BrowserExecutorRequest } from "@browserkit/protocol";
import { send } from "./cdp/send.js";
import { showAgentCursor } from "./native-browser-cursor.js";
import { pointerButtonBits, pointerPress } from "./native-browser-debugger.js";
import { humanMouse } from "./native-browser-human-input.js";
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
  await mouse("mouseMoved", step.x, step.y, held);
  if (step.action === "hover") return { hovered: true };
  return withFocusEmulation(debuggee.tabId, () => pressPointer(step, mouse));
}

function heldModifiers(step: {
  modifiers?: readonly string[] | undefined;
}): Record<string, unknown> {
  const modifiers = pointerPress(step).modifiers;
  return modifiers ? { modifiers } : {};
}

async function pressPointer(step: PointerStep, mouse: MouseSend): Promise<unknown> {
  const held = heldModifiers(step);
  if (step.action === "drag") return dragPointer(step, mouse, held);
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

async function dragPointer(
  step: PointerStep,
  mouse: MouseSend,
  held: Record<string, unknown>,
): Promise<unknown> {
  if (step.toX === undefined || step.toY === undefined) throw new Error("INVALID_TARGET");
  await mouse("mousePressed", step.x, step.y, {
    button: "left",
    buttons: 1,
    clickCount: 1,
    ...held,
  });
  try {
    for (let i = 1; i <= 12; i++)
      await mouse(
        "mouseMoved",
        step.x + ((step.toX - step.x) * i) / 12,
        step.y + ((step.toY - step.y) * i) / 12,
        { button: "left", buttons: 1, ...held },
      );
  } finally {
    await mouse("mouseReleased", step.toX, step.toY, {
      button: "left",
      buttons: 0,
      clickCount: 1,
      ...held,
    });
  }
  return { dragged: true };
}

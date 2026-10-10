import type { BrowserExecutorRequest } from "@pippin/protocol";
type Step = Extract<BrowserExecutorRequest["step"], { op: "pointer" | "keys" }>;
export async function executeInteraction(
  debuggee: chrome.debugger.Debuggee,
  step: Step,
): Promise<unknown> {
  if (step.op === "keys") return keyboard(debuggee, step.keys);
  const send = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
    chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", { type, x, y, ...extra });
  await send("mouseMoved", step.x, step.y);
  if (step.action === "hover") return { hovered: true };
  if (step.action === "drag") {
    if (step.toX === undefined || step.toY === undefined) throw new Error("INVALID_TARGET");
    await send("mousePressed", step.x, step.y, { button: "left", buttons: 1, clickCount: 1 });
    try {
      for (let i = 1; i <= 12; i++)
        await send(
          "mouseMoved",
          step.x + ((step.toX - step.x) * i) / 12,
          step.y + ((step.toY - step.y) * i) / 12,
          { button: "left", buttons: 1 },
        );
    } finally {
      await send("mouseReleased", step.toX, step.toY, {
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    }
    return { dragged: true };
  }
  const count = step.action === "doubleClick" ? 2 : 1;
  for (let click = 1; click <= count; click++) {
    await send("mousePressed", step.x, step.y, { button: "left", clickCount: click });
    await send("mouseReleased", step.x, step.y, { button: "left", clickCount: click });
  }
  return { clicked: true };
}
async function keyboard(debuggee: chrome.debugger.Debuggee, combo: string): Promise<unknown> {
  const parts = combo.split("+"),
    key = parts.pop();
  if (!key) throw new Error("INVALID_TARGET");
  const masks: Record<string, number> = {
    Alt: 1,
    Control: 2,
    Ctrl: 2,
    Meta: 4,
    Command: 4,
    Shift: 8,
  };
  let modifiers = 0;
  for (const part of parts) {
    if (!masks[part]) throw new Error("Unknown modifier: " + part);
    modifiers |= masks[part];
  }
  const names: Record<string, number> = {
    Enter: 13,
    Tab: 9,
    Escape: 27,
    Backspace: 8,
    Delete: 46,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    Space: 32,
  };
  const windowsVirtualKeyCode =
    names[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  if (!windowsVirtualKeyCode) throw new Error("Unsupported key");
  const params = { key: key === "Space" ? " " : key, modifiers, windowsVirtualKeyCode };
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
    type: "keyDown",
    ...params,
    ...(!modifiers && key.length === 1 ? { text: key } : {}),
  });
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
    type: "keyUp",
    ...params,
  });
  return { pressed: combo };
}

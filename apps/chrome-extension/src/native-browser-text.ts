import { onNode } from "./native-browser-dom.js";
import { BrowserActionError } from "./native-browser-errors.js";
export async function isFocusedInput(debuggee: chrome.debugger.Debuggee): Promise<boolean> {
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression: `(${focusedInput.toString()})()`,
    returnByValue: true,
  })) as { result?: { value?: boolean } };
  return result.result?.value === true;
}
function focusedInput() {
  let active: Element | null = document.activeElement;
  for (let i = 0; i < 20 && active; i++) {
    if (active.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
      continue;
    }
    if (active instanceof HTMLIFrameElement && active.contentDocument?.activeElement) {
      active = active.contentDocument.activeElement;
      continue;
    }
    break;
  }
  return (
    !!active &&
    !active.matches(":disabled,[readonly],[aria-disabled='true']") &&
    (active.matches("input,textarea,select") || (active as HTMLElement).isContentEditable)
  );
}

export async function fillTextNode(
  debuggee: chrome.debugger.Debuggee,
  id: number,
  value: string,
): Promise<void> {
  const group = "aeon-fill-" + crypto.randomUUID();
  try {
    const source = (await chrome.debugger.sendCommand(debuggee, "DOM.resolveNode", {
      backendNodeId: id,
      objectGroup: group,
    })) as { object?: { objectId?: string } };
    if (!source.object?.objectId) throw new Error("STALE_REF");
    const selected = (await chrome.debugger.sendCommand(debuggee, "Runtime.callFunctionOn", {
      objectId: source.object.objectId,
      functionDeclaration: selectTextInput.toString(),
      objectGroup: group,
    })) as { result?: { objectId?: string }; exceptionDetails?: unknown };
    if (selected.exceptionDetails || !selected.result?.objectId) throw new Error("NOT_EDITABLE");
    const node = (await chrome.debugger.sendCommand(debuggee, "DOM.describeNode", {
      objectId: selected.result.objectId,
    })) as { node?: { backendNodeId?: number } };
    if (!node.node?.backendNodeId) throw new Error("STALE_REF");
    if (value) await chrome.debugger.sendCommand(debuggee, "Input.insertText", { text: value });
    else await clearSelection(debuggee);
    const actual = await onNode<string>(debuggee, node.node.backendNodeId, inputValue);
    if (actual !== value)
      throw new BrowserActionError(
        "INPUT_FAILED",
        "The focused input did not retain the requested value. Inspect it before continuing.",
      );
  } finally {
    await chrome.debugger
      .sendCommand(debuggee, "Runtime.releaseObjectGroup", { objectGroup: group })
      .catch(() => undefined);
  }
}
function selectTextInput(this: HTMLInputElement | HTMLTextAreaElement) {
  if (!editable(this)) return null;
  const root = this.getRootNode() as Document | ShadowRoot;
  this.focus({ preventScroll: true });
  let selected = root.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  while (selected?.shadowRoot?.activeElement)
    selected = selected.shadowRoot.activeElement as HTMLInputElement;
  // Some comboboxes open an overlay and move focus into a replacement input.
  if (!selected || !editable(selected)) return null;
  if (selected.isContentEditable) {
    const selection = selected.ownerDocument.getSelection(),
      range = selected.ownerDocument.createRange();
    range.selectNodeContents(selected);
    selection?.removeAllRanges();
    selection?.addRange(range);
  } else selected.select();
  return selected;
  function editable(element: HTMLElement) {
    return (
      element.isConnected &&
      !element.matches(":disabled,[aria-disabled='true'],[readonly]") &&
      (element.matches("input,textarea") || element.isContentEditable)
    );
  }
}
function inputValue(this: HTMLInputElement | HTMLTextAreaElement) {
  return this.isContentEditable ? this.innerText : this.value;
}
async function clearSelection(debuggee: chrome.debugger.Debuggee) {
  const event = { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 };
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
    ...event,
    type: "rawKeyDown",
  });
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
    ...event,
    type: "keyUp",
  });
}

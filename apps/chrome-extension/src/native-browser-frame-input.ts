import { frameContext } from "./native-browser-frames.js";
import { onNode } from "./native-browser-dom.js";
import { fillNode } from "./native-browser-input.js";
import { clickAt } from "./native-browser-debugger.js";
export async function interactFrame(
  debuggee: chrome.debugger.Debuggee,
  frameId: string,
  selector: string | number,
  value?: string,
): Promise<unknown> {
  const objectId = await resolveFrameObject(debuggee, frameId, selector);
  try {
    const node = (await chrome.debugger.sendCommand(debuggee, "DOM.describeNode", {
      objectId,
    })) as { node: { backendNodeId: number } };
    if (value !== undefined) {
      await fillNode(debuggee, node.node.backendNodeId, value);
      return { filled: true };
    }
    const point = await onNode<{ x: number; y: number }>(
      debuggee,
      node.node.backendNodeId,
      function (this: HTMLElement) {
        this.scrollIntoView({ block: "center", inline: "center" });
        const box = this.getBoundingClientRect();
        if (!box.width || !box.height || this.matches(':disabled,[aria-disabled="true"]'))
          throw Error("TARGET_DISABLED");
        const x = box.left + box.width / 2,
          y = box.top + box.height / 2;
        let hit = this.ownerDocument.elementFromPoint(x, y);
        while (hit?.shadowRoot) {
          const next = hit.shadowRoot.elementFromPoint(x, y);
          if (!next || next === hit) break;
          hit = next;
        }
        if (hit !== this && !this.contains(hit)) throw Error("TARGET_BLOCKED");
        return { x, y };
      },
    );
    // Input is sent to this frame's renderer session; same-process frames need the owner offset.
    const offset = await frameOffset(debuggee, frameId);
    await clickAt(debuggee, point.x + offset.x, point.y + offset.y);
    return { clicked: true };
  } finally {
    await chrome.debugger
      .sendCommand(debuggee, "Runtime.releaseObject", { objectId })
      .catch(() => undefined);
  }
}
async function frameOffset(
  debuggee: chrome.debugger.Debuggee,
  frameId: string,
): Promise<{ x: number; y: number }> {
  const tree = (await chrome.debugger.sendCommand(debuggee, "Page.getFrameTree")) as {
    frameTree: { frame: { id: string } };
  };
  if (tree.frameTree.frame.id === frameId) return { x: 0, y: 0 };
  const owner = (await chrome.debugger.sendCommand(debuggee, "DOM.getFrameOwner", { frameId })) as {
    backendNodeId: number;
  };
  const box = (await chrome.debugger.sendCommand(debuggee, "DOM.getBoxModel", {
    backendNodeId: owner.backendNodeId,
  })) as { model: { content: number[] } };
  return { x: box.model.content[0] ?? 0, y: box.model.content[1] ?? 0 };
}

async function resolveFrameObject(
  debuggee: chrome.debugger.Debuggee,
  frameId: string,
  selector: string | number,
): Promise<string> {
  const contextId = await frameContext(debuggee, frameId);
  if (typeof selector === "number") {
    const node = (await chrome.debugger.sendCommand(debuggee, "DOM.resolveNode", {
      backendNodeId: selector,
      executionContextId: contextId,
    })) as { object: { objectId: string } };
    return node.object.objectId;
  }
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    contextId,
    expression: `(()=>{const roots=[document],items=[];while(roots.length){const root=roots.pop();items.push(...root.querySelectorAll(${JSON.stringify(selector)}));for(const el of root.querySelectorAll('*'))if(el.shadowRoot)roots.push(el.shadowRoot);}if(items.length!==1)throw Error('Expected exactly one element');return items[0]})()`,
  })) as { result?: { objectId?: string }; exceptionDetails?: unknown };
  const objectId = result.result?.objectId;
  if (!objectId || result.exceptionDetails) throw new Error("TARGET_NOT_FOUND");
  return objectId;
}

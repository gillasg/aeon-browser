import type { BrowserExecutorRequest } from "@pippin/protocol";
import { frameContext } from "./native-browser-frames.js";
import { onNode } from "./native-browser-dom.js";
type Upload = BrowserExecutorRequest & {
  step: Extract<BrowserExecutorRequest["step"], { op: "upload" }>;
};
export async function uploadFiles(
  debuggee: chrome.debugger.Debuggee,
  request: Upload,
): Promise<unknown> {
  const step = request.step;
  let backendNodeId = step.backendNodeId;
  if (!backendNodeId) {
    if (!step.selector)
      throw new Error("Choose an observed file input or file chooser backendNodeId");
    const expression = `(()=>{const roots=[document],found=[];while(roots.length){const root=roots.pop();found.push(...root.querySelectorAll(${JSON.stringify(step.selector)}));for(const el of root.querySelectorAll('*'))if(el.shadowRoot)roots.push(el.shadowRoot);}if(found.length!==1)throw Error('Expected exactly one file input');return found[0];})()`;
    const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression,
      ...(step.frameId ? { contextId: await frameContext(debuggee, step.frameId) } : {}),
    })) as { result?: { objectId?: string }; exceptionDetails?: unknown };
    const objectId = result.result?.objectId;
    if (!objectId || result.exceptionDetails) throw new Error("TARGET_NOT_FOUND");
    try {
      const node = (await chrome.debugger.sendCommand(debuggee, "DOM.describeNode", {
        objectId,
      })) as { node: { backendNodeId: number } };
      backendNodeId = node.node.backendNodeId;
    } finally {
      await chrome.debugger
        .sendCommand(debuggee, "Runtime.releaseObject", { objectId })
        .catch(() => undefined);
    }
  }
  const state = await onNode<{ type: string; multiple: boolean; disabled: boolean }>(
    debuggee,
    backendNodeId,
    function (this: HTMLInputElement) {
      return { type: this.type, multiple: this.multiple, disabled: this.disabled };
    },
  );
  if (state.type !== "file" || state.disabled || (!state.multiple && step.files.length > 1))
    throw new Error("INVALID_TARGET");
  await chrome.debugger.sendCommand(debuggee, "DOM.setFileInputFiles", {
    backendNodeId,
    files: step.files,
  });
  const files = await onNode<unknown>(debuggee, backendNodeId, function (this: HTMLInputElement) {
    return [...(this.files ?? [])].map((file) => ({
      name: file.name,
      size: file.size,
      type: file.type,
    }));
  });
  return { files, selected: true };
}

import { BrowserActionError } from "./native-browser-common.js";
interface FrameNode {
  frame: { id: string; url: string; loaderId?: string; parentId?: string };
  childFrames?: FrameNode[];
}
interface FrameInfo {
  frameId: string;
  url: string;
  frameKey: string;
  sessionId?: string;
}
const sessions = new Map<number, Map<string, string>>();
chrome.debugger.onEvent.addListener((source, method, raw) => {
  if (source.tabId === undefined) return;
  const params = raw as { sessionId?: string; targetInfo?: { targetId: string; type: string } };
  if (
    method === "Target.attachedToTarget" &&
    params.sessionId &&
    params.targetInfo?.type === "iframe"
  ) {
    const map = sessions.get(source.tabId) ?? new Map<string, string>();
    map.set(params.targetInfo.targetId, params.sessionId);
    sessions.set(source.tabId, map);
    void chrome.debugger
      .sendCommand({ tabId: source.tabId, sessionId: params.sessionId }, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      .catch(() => undefined);
  }
  if (method === "Target.detachedFromTarget")
    for (const map of sessions.values())
      for (const [id, sessionId] of map) if (sessionId === params.sessionId) map.delete(id);
});
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) sessions.delete(source.tabId);
});
export async function discoverFrames(debuggee: chrome.debugger.Debuggee): Promise<FrameInfo[]> {
  await chrome.debugger.sendCommand(debuggee, "Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  const result: FrameInfo[] = [];
  const roots: (chrome.debugger.Debuggee & { sessionId?: string })[] = [
    debuggee,
    ...[...(sessions.get(debuggee.tabId ?? -1)?.values() ?? [])].map((sessionId) => ({
      ...debuggee,
      sessionId,
    })),
  ];
  for (const source of roots) {
    try {
      const tree = (await chrome.debugger.sendCommand(source, "Page.getFrameTree")) as {
        frameTree: FrameNode;
      };
      appendFrameTree(result, tree.frameTree, source);
    } catch (error) {
      if (!source.sessionId) throw error;
    }
  }
  return result;
}
export async function frameDebuggee(
  debuggee: chrome.debugger.Debuggee,
  frameId?: string,
  frameKey?: string,
): Promise<chrome.debugger.Debuggee> {
  if (!frameId) return debuggee;
  if (!frameKey)
    throw new BrowserActionError(
      "STALE_REF",
      "Frame document key is missing. Use a handle returned by page.frames(), or pass both frameId and frameKey from the same discovery result.",
    );
  const frame = (await discoverFrames(debuggee)).find((item) => item.frameId === frameId);
  if (!frame || !frameKey || frame.frameKey !== frameKey)
    throw new BrowserActionError(
      "STALE_REF",
      "Frame navigated or disappeared; discover frames again.",
    );
  return { ...debuggee, ...(frame.sessionId ? { sessionId: frame.sessionId } : {}) };
}
export async function frameContext(
  debuggee: chrome.debugger.Debuggee,
  frameId: string,
): Promise<number> {
  const context = (await chrome.debugger.sendCommand(debuggee, "Page.createIsolatedWorld", {
    frameId,
    worldName: "aeon-browser",
  })) as { executionContextId: number };
  return context.executionContextId;
}
export async function evaluateFrame(
  debuggee: chrome.debugger.Debuggee,
  frameId: string,
  expression: string,
): Promise<unknown> {
  const contextId = await frameContext(debuggee, frameId);
  const result = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: true,
    timeout: 8000,
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: { text: string; exception?: { description: string } };
  };
  if (result.exceptionDetails)
    throw new BrowserActionError(
      "OPERATION_FAILED",
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    );
  return result.result?.value;
}

function appendFrameTree(
  result: FrameInfo[],
  root: FrameNode,
  source: chrome.debugger.Debuggee & { sessionId?: string },
): void {
  const pending = [root];
  while (pending.length && result.length < 64) {
    const node = pending.pop();
    if (!node) continue;
    const info = {
      frameId: node.frame.id,
      url: node.frame.url,
      frameKey: node.frame.id + ":" + (node.frame.loaderId ?? ""),
      ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    };
    const prior = result.findIndex((item) => item.frameId === info.frameId);
    if (prior < 0) result.push(info);
    else if (source.sessionId) result[prior] = info;
    pending.push(...(node.childFrames ?? []));
  }
}

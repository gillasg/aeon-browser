import type { BrowserElementTarget, BrowserTargetKey } from "@pippin/protocol";
import { targetIdentity, textValue, type AxNode, type AxRef } from "./native-browser-common.js";
export { withBrowserDebugger as withDebugger } from "./native-browser-session.js";

export async function resolveElement(
  debuggee: chrome.debugger.Debuggee,
  element: BrowserElementTarget | undefined,
  target: BrowserTargetKey,
  refs: Map<string, Map<string, AxRef>>,
  latestSnapshots: Map<string, string>,
): Promise<AxRef> {
  const nodes = await getAxTree(debuggee);
  if (!element) throw new Error("INVALID_TARGET");
  if (element.kind === "ref") {
    const key = targetIdentity(target);
    if (latestSnapshots.get(key) !== element.snapshotId) throw new Error("STALE_REF");
    const prior = refs.get(element.snapshotId)?.get(element.ref);
    const live = nodes.find((node) => node.backendDOMNodeId === prior?.backendNodeId);
    if (!prior || !sameSemanticNode(live, prior)) throw new Error("STALE_REF");
    return prior;
  }
  if (element.kind === "point") throw new Error("STALE_REF");
  return findUniqueLocator(nodes, element.role, element.name);
}

function sameSemanticNode(live: AxNode | undefined, prior: AxRef | undefined): boolean {
  return Boolean(
    prior &&
    live &&
    textValue(live.role?.value) === prior.role &&
    textValue(live.name?.value).slice(0, 512) === prior.name,
  );
}

function findUniqueLocator(nodes: AxNode[], role: string, name: string): AxRef {
  const matches = nodes.filter(
    (node) =>
      !node.ignored &&
      node.backendDOMNodeId !== undefined &&
      textValue(node.role?.value).toLowerCase() === role.toLowerCase() &&
      textValue(node.name?.value) === name,
  );
  if (matches.length > 1) throw new Error("AMBIGUOUS_TARGET");
  const match = matches[0];
  if (!match || match.backendDOMNodeId === undefined) throw new Error("STALE_REF");
  return { backendNodeId: match.backendDOMNodeId, role, name };
}

export async function getAxTree(debuggee: chrome.debugger.Debuggee): Promise<AxNode[]> {
  await chrome.debugger.sendCommand(debuggee, "DOM.enable");
  await chrome.debugger.sendCommand(debuggee, "Accessibility.enable");
  const result = (await chrome.debugger.sendCommand(debuggee, "Accessibility.getFullAXTree")) as {
    nodes?: AxNode[];
  };
  if (!Array.isArray(result.nodes)) throw new Error("UNSUPPORTED");
  return result.nodes;
}

export async function getViewportCenter(
  debuggee: chrome.debugger.Debuggee,
): Promise<{ x: number; y: number }> {
  const viewport = await getViewportSize(debuggee);
  return { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) };
}

export async function getViewportSize(
  debuggee: chrome.debugger.Debuggee,
): Promise<{ width: number; height: number }> {
  const result = (await chrome.debugger.sendCommand(debuggee, "Page.getLayoutMetrics")) as {
    cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
  };
  const width = Math.floor(result.cssVisualViewport?.clientWidth ?? 0);
  const height = Math.floor(result.cssVisualViewport?.clientHeight ?? 0);
  if (width < 1 || height < 1) throw new Error("UNSUPPORTED");
  return { width, height };
}

export async function getCenter(
  debuggee: chrome.debugger.Debuggee,
  backendNodeId: number,
): Promise<{ x: number; y: number }> {
  const result = (await chrome.debugger.sendCommand(debuggee, "DOM.getBoxModel", {
    backendNodeId,
  })) as { model?: { content?: number[] } };
  const quad = result.model?.content;
  if (!quad || quad.length < 8) throw new Error("STALE_REF");
  const x = [quad[0], quad[2], quad[4], quad[6]];
  const y = [quad[1], quad[3], quad[5], quad[7]];
  if (
    x.some((coordinate) => coordinate === undefined) ||
    y.some((coordinate) => coordinate === undefined)
  )
    throw new Error("STALE_REF");
  return {
    x: centerOf(x),
    y: centerOf(y),
  };
}

function centerOf(coordinates: (number | undefined)[]): number {
  const total = coordinates.reduce<number>((sum, coordinate) => sum + (coordinate ?? 0), 0);
  return Math.round(total / coordinates.length);
}

export async function clickAt(
  debuggee: chrome.debugger.Debuggee,
  x: number,
  y: number,
): Promise<void> {
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

export async function fillAt(
  debuggee: chrome.debugger.Debuggee,
  x: number,
  y: number,
  value: string,
): Promise<void> {
  await clickAt(debuggee, x, y);
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Control",
  });
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    modifiers: 2,
  });
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    modifiers: 2,
  });
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Control",
  });
  await chrome.debugger.sendCommand(debuggee, "Input.insertText", { text: value });
}

export async function scrollAt(
  debuggee: chrome.debugger.Debuggee,
  x: number,
  y: number,
  direction: "up" | "down" | "left" | "right",
  amount: number,
): Promise<void> {
  const positive = direction === "down" || direction === "right" ? 1 : -1;
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX: direction === "left" || direction === "right" ? amount * positive : 0,
    deltaY: direction === "up" || direction === "down" ? amount * positive : 0,
  });
}

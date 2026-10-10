import type { BrowserExecutorRequest, BrowserExecutorResult, BrowserStep } from "@pippin/protocol";
import {
  withBrowserDebugger,
  reconnectBrowserSession,
  assertRequestActive,
} from "./native-browser-session.js";
import { discoverFrames, frameDebuggee, evaluateFrame } from "./native-browser-frames.js";
import { executeBrowserEvent } from "./native-browser-events.js";
import { executeDownload } from "./native-browser-downloads.js";
import { uploadFiles } from "./native-browser-files.js";
import { executeInteraction } from "./native-browser-interaction.js";
import { refreshInventoryTab } from "./native-inventory-client.js";
import { interactFrame } from "./native-browser-frame-input.js";
import { createSemanticNodes } from "./native-browser-observation.js";
import { type AxNode, sameTarget } from "./native-browser-common.js";
type Capability = Extract<
  BrowserStep,
  { op: "event" | "frames" | "upload" | "downloads" | "pointer" | "keys" | "reconnect" }
>;
export function isCapabilityStep(step: BrowserStep): step is Capability {
  return ["event", "frames", "upload", "downloads", "pointer", "keys", "reconnect"].includes(
    step.op,
  );
}
type Request = BrowserExecutorRequest & { step: Capability };
export async function performCapability(
  request: Request,
  revalidate: (request: BrowserExecutorRequest, tabId: number) => Promise<void>,
): Promise<BrowserExecutorResult> {
  const step = request.step,
    tabId = step.target.tabId;
  await revalidate(request, tabId);
  if (step.op === "reconnect") await reconnectBrowserSession(tabId);
  const data = await withBrowserDebugger(tabId, async (root) => {
    await revalidate(request, tabId);
    const debuggee =
      "frameId" in step ? await frameDebuggee(root, step.frameId, step.frameKey) : root;
    if (step.op === "event") return executeBrowserEvent({ ...request, step }, debuggee);
    if (step.op === "frames") return executeFrame(root, debuggee, step);
    if (step.op === "upload") return uploadFiles(debuggee, { ...request, step });
    if (step.op === "downloads") return executeDownload({ ...request, step });
    if (step.op === "pointer" || step.op === "keys") return executeInteraction(debuggee, step);
    return { reconnected: true, handlesMustBeRefreshed: true };
  });
  if (JSON.stringify(data).length > 1_000_000)
    throw new Error("Browser result exceeds 1 MB; select fewer fields or split the request");
  assertRequestActive(request);
  const tab = await refreshInventoryTab(tabId);
  if (!tab || !sameTarget(tab.target, step.target)) throw new Error("TARGET_LOST");
  return {
    kind: "page",
    source: "website",
    trust: "untrusted",
    target: tab.target,
    documentEpoch: tab.documentEpoch,
    url: tab.url,
    data,
  };
}
async function executeFrame(
  root: chrome.debugger.Debuggee,
  debuggee: chrome.debugger.Debuggee,
  step: Extract<BrowserStep, { op: "frames" }>,
): Promise<unknown> {
  if (step.action === "list") return discoverFrames(root);
  if (!step.frameId)
    throw new Error(
      "INVALID_TARGET: pass both frameId and frameKey from page.frames(); a frameKey alone is not a frame target",
    );
  if (step.action === "evaluate")
    return evaluateFrame(debuggee, step.frameId, step.expression ?? "");
  if (step.action === "click" || step.action === "fill") {
    const element = step.selector ?? step.backendNodeId;
    if (element === undefined) throw new Error("INVALID_TARGET");
    return interactFrame(debuggee, step.frameId, element, frameValue(step));
  }
  if (step.action === "snapshot") return frameSnapshot(debuggee, step.frameId);
  if (!step.method || /^(Browser|Target)\./.test(step.method)) throw new Error("UNSUPPORTED");
  return chrome.debugger.sendCommand(debuggee, step.method, step.params);
}
async function frameSnapshot(
  debuggee: chrome.debugger.Debuggee,
  frameId: string,
): Promise<unknown> {
  const tree = (await chrome.debugger.sendCommand(debuggee, "Accessibility.getFullAXTree", {
    frameId,
  })) as { nodes: AxNode[] };
  return createSemanticNodes(tree.nodes);
}

function frameValue(step: Extract<BrowserStep, { op: "frames" }>): string | undefined {
  return step.action === "fill" ? (step.value ?? "") : undefined;
}

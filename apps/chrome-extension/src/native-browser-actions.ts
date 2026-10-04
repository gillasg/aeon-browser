import { clickScreenshotPoint } from "./native-browser-point.js";
import { prepareElement } from "./native-browser-prepare.js";
import { fillNode } from "./native-browser-input.js";
import {
  BrowserExecutorResultSchema,
  type BrowserExecutorRequest,
  type BrowserExecutorResult,
  type BrowserStep,
} from "@pippin/protocol";
import { refreshInventoryTab } from "./native-inventory-client.js";
import { safePage } from "./native-browser-common.js";
import { scrollWithFeedback } from "./native-browser-scroll.js";
import { clickAt, getViewportCenter, scrollAt, withDebugger } from "./native-browser-debugger.js";
import { observeSemantic } from "./native-browser-observation.js";

type ActionRequest = BrowserExecutorRequest & {
  step: Extract<BrowserStep, { op: "click" | "fill" | "scroll" }>;
};
type RevalidateTarget = (request: BrowserExecutorRequest, tabId: number) => Promise<void>;

export async function performAction(
  request: ActionRequest,
  revalidateTarget: RevalidateTarget,
): Promise<BrowserExecutorResult> {
  const tabId = request.step.target.tabId;
  const scroll = await withDebugger(tabId, async (debuggee) => {
    await revalidateTarget(request, tabId);
    return request.step.op === "scroll"
      ? scrollWithFeedback(debuggee, { ...request, step: request.step })
      : dispatchAction(debuggee, request, revalidateTarget);
  });
  if (scroll) await revalidateTarget(request, tabId);
  const current = await refreshInventoryTab(tabId);
  if (!current) throw new Error("TARGET_LOST");
  const liveTab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!liveTab?.url || !safePage(liveTab.url)) throw new Error("TARGET_LOST");
  const observation = scroll
    ? undefined
    : await observeSemantic(
        { ...request, expectedDocumentEpoch: current.documentEpoch },
        liveTab,
        revalidateTarget,
      );
  return BrowserExecutorResultSchema.parse({
    kind: "action",
    target: current.target,
    documentEpoch: current.documentEpoch,
    url: liveTab.url,
    ...(observation ? { observation } : {}),
    ...(scroll ? { scroll } : {}),
  });
}

async function dispatchAction(
  debuggee: chrome.debugger.Debuggee,
  request: ActionRequest,
  revalidateTarget: RevalidateTarget,
): Promise<void> {
  await revalidateTarget(request, request.step.target.tabId);
  if (request.step.op === "click" && request.step.element.kind === "point")
    return clickScreenshotPoint(debuggee, request);
  if (request.step.op === "scroll" && !request.step.element)
    return scrollViewport(debuggee, request);
  if (!request.step.element) throw new Error("INVALID_TARGET");
  const { node, point: box } = await prepareElement(
    debuggee,
    request,
    request.step.element,
    () => revalidateTarget(request, request.step.target.tabId),
    request.step.op === "fill",
  );
  if (request.step.op === "click") await clickAt(debuggee, box.x, box.y);
  else if (request.step.op === "fill")
    await fillNode(debuggee, node.backendNodeId, request.step.value);
  else await scrollAt(debuggee, box.x, box.y, request.step.direction, request.step.amount);
}

async function scrollViewport(
  debuggee: chrome.debugger.Debuggee,
  request: ActionRequest,
): Promise<void> {
  if (request.step.op !== "scroll" || request.step.element) throw new Error("INVALID_TARGET");
  const center = await getViewportCenter(debuggee);
  await scrollAt(debuggee, center.x, center.y, request.step.direction, request.step.amount);
}

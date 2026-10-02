import {
  BrowserExecutorResultSchema,
  type BrowserExecutorRequest,
  type BrowserExecutorResult,
  type BrowserTargetKey,
  type BrowserSemanticNode,
} from "@pippin/protocol";
import { currentInventoryTabs } from "./native-inventory-client.js";
import {
  booleanProperty,
  sameTarget,
  targetIdentity,
  textValue,
  type AxNode,
  type AxRef,
  type ScreenshotRef,
} from "./native-browser-common.js";
import { getAxTree, withDebugger } from "./native-browser-debugger.js";

const REF_LIMIT = 180;
const SCREENSHOT_MAX_AGE_MS = 5000;
const refs = new Map<string, Map<string, AxRef>>();
const latestSnapshots = new Map<string, string>();
const screenshots = new Map<string, ScreenshotRef>();
export const browserObservationRefs = { refs, latestSnapshots };

type RevalidateTarget = (request: BrowserExecutorRequest, tabId: number) => Promise<void>;

export async function observeSemantic(
  request: BrowserExecutorRequest,
  tab: chrome.tabs.Tab,
  revalidateTarget: RevalidateTarget,
): Promise<BrowserExecutorResult> {
  const target = targetForRequest(request);
  const current = currentInventoryTabs().find((item) => sameTarget(item.target, target));
  if (!current || current.documentEpoch !== request.expectedDocumentEpoch)
    throw new Error("TARGET_LOST");
  const nodes = await withDebugger(target.tabId, async (debuggee) => {
    await revalidateTarget(request, target.tabId);
    return getAxTree(debuggee);
  });
  const snapshotId = crypto.randomUUID();
  const semantic = createSemanticNodes(nodes);
  const key = targetIdentity(target);
  refs.set(snapshotId, semantic.refs);
  latestSnapshots.set(key, snapshotId);
  trimOldRefs(snapshotId);
  return BrowserExecutorResultSchema.parse({
    kind: "semantic",
    source: "website",
    trust: "untrusted",
    target,
    documentEpoch: current.documentEpoch,
    snapshotId,
    url: tab.url ?? current.url,
    nodes: semantic.nodes,
    truncated: nodes.length > semantic.nodes.length,
  });
}

function targetForRequest(request: BrowserExecutorRequest): BrowserTargetKey {
  if (
    request.step.op === "listTabs" ||
    request.step.op === "openTab" ||
    request.step.op === "attachTab"
  )
    throw new Error("INVALID_TARGET");
  return request.step.target;
}

function createSemanticNodes(nodes: AxNode[]): {
  refs: Map<string, AxRef>;
  nodes: BrowserSemanticNode[];
} {
  const map = new Map<string, AxRef>();
  const compact: BrowserSemanticNode[] = [];
  for (const node of nodes) {
    if (compact.length >= REF_LIMIT) break;
    const backendNodeId = node.backendDOMNodeId;
    const role = textValue(node.role?.value);
    if (node.ignored || backendNodeId === undefined || !role) continue;
    const name = textValue(node.name?.value).slice(0, 512);
    const ref = `e${compact.length}`;
    map.set(ref, { backendNodeId, role, name });
    compact.push({
      ref,
      role: role.slice(0, 80),
      name,
      ...(node.value ? { value: textValue(node.value.value).slice(0, 512) } : {}),
      ...booleanProperty(node, "disabled"),
      ...booleanProperty(node, "checked"),
      ...booleanProperty(node, "focused"),
    });
  }
  return { refs: map, nodes: compact };
}

function trimOldRefs(snapshotId: string): void {
  for (const prior of refs.keys()) if (prior !== snapshotId && refs.size > 8) refs.delete(prior);
}

export async function captureScreenshot(
  request: BrowserExecutorRequest,
  tab: chrome.tabs.Tab,
  revalidateTarget: RevalidateTarget,
): Promise<BrowserExecutorResult> {
  const target = targetForRequest(request);
  const result = await withDebugger(target.tabId, async (debuggee) => {
    await revalidateTarget(request, target.tabId);
    const metrics = (await chrome.debugger.sendCommand(debuggee, "Page.getLayoutMetrics")) as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
    };
    await chrome.debugger.sendCommand(debuggee, "Page.enable");
    const capture = (await chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 60,
      captureBeyondViewport: false,
    })) as { data?: string };
    const width = Math.floor(metrics.cssVisualViewport?.clientWidth ?? 0);
    const height = Math.floor(metrics.cssVisualViewport?.clientHeight ?? 0);
    if (!capture.data || width < 1 || height < 1 || capture.data.length > 1_500_000)
      throw new Error("UNSUPPORTED");
    const screenshotId = crypto.randomUUID();
    const capturedAt = Date.now();
    screenshots.set(screenshotId, {
      target,
      epoch: request.expectedDocumentEpoch ?? -1,
      viewport: { width, height },
      capturedAt,
    });
    return {
      kind: "screenshot" as const,
      source: "website" as const,
      trust: "untrusted" as const,
      target,
      documentEpoch: request.expectedDocumentEpoch ?? -1,
      screenshotId,
      url: tab.url ?? "",
      viewport: { width, height },
      capturedAt,
      mimeType: "image/jpeg" as const,
      dataBase64: capture.data,
    };
  });
  return BrowserExecutorResultSchema.parse(result);
}

export function screenshotPoint(
  id: string,
  target: BrowserTargetKey,
  epoch: number,
): ScreenshotRef {
  const screenshot = screenshots.get(id);
  if (
    !screenshot ||
    !sameTarget(screenshot.target, target) ||
    screenshot.epoch !== epoch ||
    Date.now() - screenshot.capturedAt > SCREENSHOT_MAX_AGE_MS
  )
    throw new Error("STALE_REF");
  return screenshot;
}

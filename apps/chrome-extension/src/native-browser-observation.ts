import { captureViewport } from "./native-browser-screenshot.js";
import {
  BrowserExecutorResultSchema,
  type BrowserExecutorRequest,
  type BrowserExecutorResult,
  type BrowserTargetKey,
} from "@pippin/protocol";
import { currentInventoryTabs } from "./native-inventory-client.js";
import {
  sameTarget,
  targetIdentity,
  type AxRef,
  type ScreenshotRef,
} from "./native-browser-common.js";
import { getAxTree, withDebugger } from "./native-browser-debugger.js";

import { createSemanticNodes, filterVisibleTextNodes } from "./native-browser-semantic.js";
import { scopedBackendIds } from "./native-browser-dom.js";
import { settleBrowserPage } from "./native-browser-settle.js";
import { visiblePageText } from "./native-browser-visible.js";
const SCREENSHOT_MAX_AGE_MS = 60_000;
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
  const { nodes, text } = await withDebugger(target.tabId, async (debuggee) => {
    await revalidateTarget(request, target.tabId);
    await settleBrowserPage(debuggee, 3000, 0);
    await revalidateTarget(request, target.tabId);
    const [nodes, text] = await Promise.all([getAxTree(debuggee), visiblePageText(debuggee)]);
    return { nodes, text };
  });
  const snapshotId = crypto.randomUUID();
  const options =
    request.step.op === "observe"
      ? request.step
      : { query: undefined, interactive: undefined, selector: undefined };
  const scopedIds = options.selector
    ? await withDebugger(target.tabId, (debuggee) =>
        scopedBackendIds(debuggee, options.selector ?? ""),
      )
    : undefined;
  const scoped = scopedIds
    ? nodes.filter((node) => scopedIds.has(node.backendDOMNodeId ?? -1))
    : nodes;
  await revalidateTarget(request, target.tabId);
  const semantic = createSemanticNodes(filterVisibleTextNodes(scoped, text), options);
  const key = targetIdentity(target);
  for (const ref of semantic.refs.values()) ref.documentEpoch = current.documentEpoch;
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
    truncated: semantic.truncated,
    text,
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

function trimOldRefs(snapshotId: string): void {
  for (const prior of refs.keys()) if (prior !== snapshotId && refs.size > 8) refs.delete(prior);
  for (const [key, id] of latestSnapshots) if (!refs.has(id)) latestSnapshots.delete(key);
}

export async function captureScreenshot(
  request: BrowserExecutorRequest,
  tab: chrome.tabs.Tab,
  revalidateTarget: RevalidateTarget,
): Promise<BrowserExecutorResult> {
  const target = targetForRequest(request);
  const result = await withDebugger(target.tabId, async (debuggee) => {
    await revalidateTarget(request, target.tabId);
    const capture = await captureViewport(debuggee);
    await revalidateTarget(request, target.tabId);
    const screenshotId = crypto.randomUUID();
    const capturedAt = Date.now();
    screenshots.set(screenshotId, {
      target,
      epoch: request.expectedDocumentEpoch ?? -1,
      viewport: capture.viewport,
      capturedAt,
      fingerprint: capture.fingerprint,
      scrollX: capture.scrollX,
      scrollY: capture.scrollY,
    });
    while (screenshots.size > 8) screenshots.delete(screenshots.keys().next().value ?? "");
    return {
      kind: "screenshot" as const,
      source: "website" as const,
      trust: "untrusted" as const,
      target,
      documentEpoch: request.expectedDocumentEpoch ?? -1,
      screenshotId,
      url: tab.url ?? "",
      viewport: capture.viewport,
      capturedAt,
      mimeType: "image/jpeg" as const,
      dataBase64: capture.dataBase64,
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

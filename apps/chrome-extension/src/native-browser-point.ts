import type { BrowserExecutorRequest, BrowserStep } from "@pippin/protocol";
import { viewportFingerprint } from "./native-browser-navigation.js";
import { screenshotPoint } from "./native-browser-observation.js";
import { clickAt } from "./native-browser-debugger.js";
type ActionRequest = BrowserExecutorRequest & {
  step: Extract<BrowserStep, { op: "click" | "fill" | "scroll" }>;
};
export async function clickScreenshotPoint(
  debuggee: chrome.debugger.Debuggee,
  request: ActionRequest,
): Promise<void> {
  if (request.step.op !== "click" || request.step.element.kind !== "point")
    throw new Error("INVALID_TARGET");
  const point = screenshotPoint(
    request.step.element.screenshotId,
    request.step.target,
    request.expectedDocumentEpoch ?? -1,
  );
  const metrics = (await chrome.debugger.sendCommand(debuggee, "Page.getLayoutMetrics")) as {
    cssVisualViewport?: {
      clientWidth?: number;
      clientHeight?: number;
      pageX?: number;
      pageY?: number;
    };
  };
  const viewport = metrics.cssVisualViewport;
  if (
    viewport?.clientWidth !== point.viewport.width ||
    viewport.clientHeight !== point.viewport.height ||
    Math.abs((viewport.pageX ?? 0) - point.scrollX) > 1 ||
    Math.abs((viewport.pageY ?? 0) - point.scrollY) > 1
  )
    throw new Error("STALE_REF");
  if ((await viewportFingerprint(debuggee)) !== point.fingerprint) throw new Error("STALE_REF");
  await clickAt(
    debuggee,
    Math.round(point.viewport.width * request.step.element.x),
    Math.round(point.viewport.height * request.step.element.y),
  );
}

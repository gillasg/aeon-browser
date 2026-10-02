import type { BrowserScrollState } from "@pippin/protocol";
import {
  getCenter,
  getViewportCenter,
  resolveElement,
  scrollAt,
} from "./native-browser-debugger.js";
import { browserObservationRefs } from "./native-browser-observation.js";
import type { BrowserExecutorRequest, BrowserStep } from "@pippin/protocol";
import { selectScrollContainer, measureScroll } from "./native-browser-scroll-container.js";
type ScrollRequest = BrowserExecutorRequest & { step: Extract<BrowserStep, { op: "scroll" }> };

export async function scrollWithFeedback(
  debuggee: chrome.debugger.Debuggee,
  request: ScrollRequest,
): Promise<BrowserScrollState> {
  const step = request.step;
  const point = step.element
    ? await elementCenter(debuggee, request)
    : await getViewportCenter(debuggee);
  const horizontal = step.direction === "left" || step.direction === "right";
  const objectId = await selectScrollContainer(debuggee, point, horizontal);
  try {
    const before = await measureScroll(debuggee, objectId, horizontal);
    await scrollAt(debuggee, point.x, point.y, step.direction, step.amount);
    let after = before;
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const next = await measureScroll(debuggee, objectId, horizontal);
      const settled =
        attempt >= 2 && next.position === after.position && next.extent === after.extent;
      after = next;
      if (settled) break;
    }
    const forward = step.direction === "down" || step.direction === "right";
    return {
      ...after,
      direction: step.direction,
      moved: Math.abs(after.position - before.position) > 1,
      atBoundary: forward
        ? after.position + after.viewport >= after.extent - 2
        : after.position <= 2,
    };
  } finally {
    await chrome.debugger
      .sendCommand(debuggee, "Runtime.releaseObject", { objectId })
      .catch(() => undefined);
  }
}

async function elementCenter(debuggee: chrome.debugger.Debuggee, request: ScrollRequest) {
  const ref = await resolveElement(
    debuggee,
    request.step.element,
    request.step.target,
    browserObservationRefs.refs,
    browserObservationRefs.latestSnapshots,
  );
  return getCenter(debuggee, ref.backendNodeId);
}

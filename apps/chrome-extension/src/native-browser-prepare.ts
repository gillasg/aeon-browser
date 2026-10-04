import type { BrowserElementTarget, BrowserExecutorRequest } from "@pippin/protocol";
import { resolveElement } from "./native-browser-debugger.js";
import { browserObservationRefs } from "./native-browser-observation.js";
import type { AxRef } from "./native-browser-common.js";
import { actionablePoint } from "./native-browser-input.js";

// Retry only preparation. A delivered click, key or insertion is never replayed.
export async function prepareElement(
  debuggee: chrome.debugger.Debuggee,
  request: BrowserExecutorRequest,
  element: BrowserElementTarget,
  revalidate: () => Promise<void>,
  editable = false,
): Promise<{ node: AxRef; point: { x: number; y: number } }> {
  if (!("target" in request.step)) throw new Error("INVALID_TARGET");
  for (let attempt = 0; ; attempt++) {
    await revalidate();
    try {
      const node = await resolveElement(
        debuggee,
        element,
        request.step.target,
        browserObservationRefs.refs,
        browserObservationRefs.latestSnapshots,
        request.expectedDocumentEpoch,
      );
      const point = await actionablePoint(debuggee, node.backendNodeId, editable);
      await revalidate();
      return { node, point };
    } catch (caught) {
      const error = normalizePreparationError(caught);
      if (attempt >= 2 || !(error instanceof Error) || !retryablePreparation(error, element))
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

function retryablePreparation(error: Error, element: BrowserElementTarget): boolean {
  if (["TARGET_NOT_FOUND", "TARGET_HIDDEN", "TARGET_BLOCKED"].includes(error.message)) return true;
  return (
    element.kind !== "ref" &&
    (error.message === "STALE_REF" ||
      /could not find node|no node with|context.*destroyed|cannot find context/i.test(
        error.message,
      ))
  );
}

function normalizePreparationError(error: unknown): unknown {
  if (
    error instanceof Error &&
    /could not find node|no node with|context.*destroyed|cannot find context/i.test(error.message)
  )
    return new Error("STALE_REF");
  return error;
}

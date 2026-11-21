import type { BrowserExecutorRequest, BrowserStep } from "@browserkit/protocol";
import { drivablePage, sameTarget } from "./native-browser-common.js";
import type { currentInventoryTabs } from "./native-inventory-client.js";

// Which steps act on a known tab, and whether the inventory still shows that tab as the request saw it.

export type TargetStep = Exclude<BrowserStep, { op: "listTabs" | "openTab" | "attachTab" }>;

export function isTargetStep(step: BrowserStep): step is TargetStep {
  return !["listTabs", "openTab", "attachTab"].includes(step.op);
}

export function inventoryMatchesRequest(
  tab: ReturnType<typeof currentInventoryTabs>[number] | undefined,
  request: BrowserExecutorRequest,
): boolean {
  return Boolean(
    tab &&
    isTargetStep(request.step) &&
    sameTarget(tab.target, request.step.target) &&
    (request.step.op === "event" ||
      request.step.op === "downloads" ||
      tab.documentEpoch === request.expectedDocumentEpoch) &&
    drivablePage(tab.url),
  );
}

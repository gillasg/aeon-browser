import { browserStepWrites, type BrowserStep } from "@aeon/protocol";

/** Reads skip the tab claim, so two agents can read one tab at once; actions still queue. */
export function isWriteStep(step: BrowserStep): boolean {
  return browserStepWrites(step);
}

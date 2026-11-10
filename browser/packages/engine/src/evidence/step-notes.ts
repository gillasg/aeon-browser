import type { BrowserExecutorResult } from "@browserkit/protocol";
import { withWaitNote } from "../native-browser-closed-tab.js";
import { takeFedCmNote } from "../native-browser-fedcm.js";
import { withDialogWarn } from "./dialogs.js";

/** Notes the model reads on the step that just finished: waits, sign-in, and dialog warns. */
export function annotateStep(result: BrowserExecutorResult, tabId: number): BrowserExecutorResult {
  return withDialogWarn(withFedCmNote(withWaitNote(result, tabId), tabId), tabId);
}

function withFedCmNote(result: BrowserExecutorResult, tabId: number): BrowserExecutorResult {
  if (result.kind !== "action") return result;
  const note = takeFedCmNote(tabId);
  if (!note) return result;
  return { ...result, note: (result.note ? `${result.note} ${note}` : note).slice(0, 1000) };
}

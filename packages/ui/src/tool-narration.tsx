import type { ReactElement } from "react";
import type { ToolStep } from "./transcript-model.js";

/** The model's line as it started this step: muted, inside the disclosure, never a chat bubble. */
export function ToolNarration({ step }: { step: ToolStep }): ReactElement | null {
  if (!step.narration) return null;
  return <p className="activity-narration">{step.narration}</p>;
}

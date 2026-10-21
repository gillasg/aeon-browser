// The orb's run model is the shared one in @aeon/ui (run-model.ts), so the island, the side panel
// and the chat transcript describe a run the same way. The orb keeps its own names for it.

export {
  applyEvent,
  cursorSteps,
  describeTool,
  formatRunDuration as formatDuration,
  inferPath,
  initialRun,
  spotlightBox,
  summarize,
} from "@aeon/ui";
export type {
  AgentRun as OrbRun,
  RunAction as OrbAction,
  RunBox as OrbBox,
  RunCursorStep as OrbCursorStep,
  RunPath as OrbPath,
  RunStatus as OrbStatus,
  RunStep as OrbStep,
} from "@aeon/ui";

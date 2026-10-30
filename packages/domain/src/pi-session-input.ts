import type { PiAttachment } from "./chat.js";
export interface PiBrowserContextRecord {
  contextId: string;
  kind: "page" | "selection";
  capturedAt: string;
  target: {
    clientInstanceId: string;
    browserRunId: string;
    tabId: number;
    tabIncarnation: string;
  };
  url: string;
  title?: string | undefined;
  selectedText?: string | undefined;
  selectionTruncated?: boolean | undefined;
  sourceStatus?: "current" | "stale" | "lost" | "offline" | undefined;
}

/** Limits on one run: once one is reached the agent gets one last turn to deliver, without tools. */
export interface PiRunBudget {
  maxSteps?: number | undefined;
  maxMinutes?: number | undefined;
  /** In US dollars, as the model provider prices the run. */
  maxCost?: number | undefined;
}

export interface PiSessionInput {
  text: string;
  budget?: PiRunBudget;
  attachments?: readonly PiAttachment[];
  browserContext?: PiBrowserContextRecord;
  browserContexts?: PiBrowserContextRecord[];
}

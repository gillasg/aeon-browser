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

export interface PiSessionInput {
  text: string;
  attachments?: readonly PiAttachment[];
  browserContext?: PiBrowserContextRecord;
  browserContexts?: PiBrowserContextRecord[];
}

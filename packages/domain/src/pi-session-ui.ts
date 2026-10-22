import type {
  PiEntryCategory,
  PiEntryProjection,
  PiMessageProjection,
  PiContextUsage,
  PiRunState,
} from "./chat.js";
import type { PiJsonValue } from "./pi-content.js";

export interface PiSlashCommand {
  kind: "builtin" | "extension" | "skill" | "prompt-template";
  name: string;
  invocation: string;
  description: string;
  argumentHint: string | null;
}

export interface PiTreeEntry {
  entryId: string;
  parentEntryId: string | null;
  category: PiEntryCategory;
  timestamp: string;
  label: string | null;
  preview: string;
  currentLeaf: boolean;
}

export interface PiExtensionUiRequest {
  requestId: string;
  kind: "select" | "confirm" | "input" | "editor";
  title: string;
  message: string | null;
  options: readonly string[];
  placeholder: string | null;
  prefill: string | null;
  expiresAt: string;
}

export interface PiExtensionUiNotice {
  noticeId: string;
  message: string;
  type: "info" | "warning" | "error";
  createdAt: string;
}

export type PiSessionEvent =
  | {
      kind: "view-replaced";
      entries: readonly PiEntryProjection[];
      runState: PiRunState;
      contextUsage: PiContextUsage | null;
    }
  | { kind: "entry-added"; entry: PiEntryProjection }
  | {
      kind: "message-start" | "message-update" | "message-end";
      message: PiMessageProjection;
    }
  | {
      kind: "tool-start";
      toolCallId: string;
      toolName: string;
      arguments: { readonly [key: string]: PiJsonValue };
      parentToolCallId?: string;
    }
  | {
      kind: "tool-update";
      toolCallId: string;
      toolName: string;
      arguments: { readonly [key: string]: PiJsonValue };
      partialResult: string;
      /** How far a long job inside this call has got (bu.progress in browser_code). */
      progress?: { done: number; total?: number; label?: string };
      parentToolCallId?: string;
    }
  | {
      kind: "tool-end";
      changeDiff?: string;
      toolCallId: string;
      toolName: string;
      result: string;
      isError: boolean;
      /** Which fast path the tool used, for the speed chip and the orb. */
      path?: "recipe" | "site-api" | "data" | "url" | "read" | "ui";
      durationMs?: number;
      parentToolCallId?: string;
    }
  | { kind: "run-state"; state: PiRunState }
  | { kind: "context-usage"; contextUsage: PiContextUsage | null }
  | { kind: "turn-boundary"; active: boolean }
  | { kind: "activity"; state: "running" | "settled" }
  | { kind: "queue-changed"; steeringCount: number; followUpCount: number }
  | { kind: "extension-ui-request"; request: PiExtensionUiRequest }
  | { kind: "extension-ui-resolved"; requestId: string }
  | { kind: "extension-ui-notice"; notice: PiExtensionUiNotice }
  | {
      kind: "chat-metadata";
      title: string;
      projectId: string | null;
      pinned: boolean;
      archived: boolean;
      updatedAt: string;
    };

export type PiSessionEventListener = (event: PiSessionEvent) => void;

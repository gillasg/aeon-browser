import type { PiBrowserContextRecord } from "./chat.js";

export type PiJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly PiJsonValue[]
  | { readonly [key: string]: PiJsonValue };

export type PiContentBlock =
  | { type: "text"; text: string; truncated?: boolean }
  | { type: "browser-context"; record: PiBrowserContextRecord }
  | {
      type: "routine-invocation";
      runId: string;
      routineId: string;
      title: string;
      scheduledSlot: string;
      instruction: string;
    }
  | {
      type: "routine-result";
      runId: string;
      routineId: string;
      state: "completed" | "failed";
      piEntryId: string;
      acceptedTurnId: string;
    }
  | {
      type: "thread-message";
      deliveryId: string;
      senderChatId: string;
      senderTitle: string;
      message: string;
      inReplyTo?: string;
    }
  | { type: "thinking"; text: string; redacted?: boolean; truncated?: boolean }
  | { type: "image"; mimeType: string; byteLength: number }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      arguments: { readonly [key: string]: PiJsonValue };
    };

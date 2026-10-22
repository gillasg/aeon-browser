import { z } from "zod";
import { PiBrowserContextRecordSchema } from "@browser-use-extension/protocol";
import { ChatCatalogItemSchema, ChatIdSchema, ChatSummarySchema } from "./chat-catalog-dto.js";
export {
  ChatIdSchema,
  ChatStatusSchema,
  ChatSummarySchema,
  ChatCatalogItemSchema,
  EffectivePiResourcesSchema,
} from "./chat-catalog-dto.js";
export type { EffectivePiResourcesDto } from "./chat-catalog-dto.js";
export {
  HomeManagementSnapshotSchema,
  HomeRoutineCardSchema,
  ManagementSnapshotSchema,
} from "./management-dto.js";
export type {
  HomeManagementSnapshotDto,
  HomeRoutineCardDto,
  ManagementSnapshotDto,
} from "./management-dto.js";

export { PiAttachmentSchema } from "./pi-attachment-dto.js";
export type { PiAttachmentDto } from "./pi-attachment-dto.js";

export const PiSlashCommandSchema = z
  .object({
    kind: z.enum(["builtin", "extension", "skill", "prompt-template"]),
    name: z.string().min(1).max(120),
    invocation: z.string().min(1).max(200),
    description: z.string().max(1000),
    argumentHint: z.string().max(500).nullable(),
  })
  .strict();
export const PiTreeEntrySchema = z
  .object({
    entryId: z.string().min(1).max(160),
    parentEntryId: z.string().max(160).nullable(),
    category: z.enum(["message", "metadata", "branch", "other"]),
    timestamp: z.string().datetime(),
    label: z.string().max(160).nullable(),
    preview: z.string().max(160),
    currentLeaf: z.boolean(),
  })
  .strict();
export const PiExtensionUiRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    kind: z.enum(["select", "confirm", "input", "editor"]),
    title: z.string().max(200),
    message: z.string().max(1000).nullable(),
    options: z.array(z.string().max(200)).max(64),
    placeholder: z.string().max(200).nullable(),
    prefill: z.string().max(20_000).nullable(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export const PiExtensionUiNoticeSchema = z
  .object({
    noticeId: z.string().uuid(),
    message: z.string().max(300),
    type: z.enum(["info", "warning", "error"]),
    createdAt: z.string().datetime(),
  })
  .strict();
export const PiUiSnapshotSchema = z
  .object({
    tree: z.array(PiTreeEntrySchema).max(1000),
    slashCommands: z.array(PiSlashCommandSchema).max(256),
    extensionDialogs: z.array(PiExtensionUiRequestSchema).max(8),
    notices: z.array(PiExtensionUiNoticeSchema).max(10),
  })
  .strict();
export type PiUiSnapshotDto = z.infer<typeof PiUiSnapshotSchema>;

export const ChatEventCursorSchema = z
  .object({ epoch: z.string().uuid(), revision: z.number().int().nonnegative() })
  .strict();

const PiContentBlockSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string().max(24_020),
      truncated: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("browser-context"), record: PiBrowserContextRecordSchema }).strict(),
  z
    .object({
      type: z.literal("routine-invocation"),
      runId: z.string().uuid(),
      routineId: z.string().uuid(),
      title: z.string().min(1).max(120),
      scheduledSlot: z.string().min(1).max(100),
      instruction: z.string().min(1).max(20_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("routine-result"),
      runId: z.string().uuid(),
      routineId: z.string().uuid(),
      state: z.enum(["completed", "failed"]),
      piEntryId: z.string().min(1).max(160),
      acceptedTurnId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal("thread-message"),
      deliveryId: z.string().uuid(),
      senderChatId: ChatIdSchema,
      senderTitle: z.string().min(1).max(120),
      message: z.string().min(1).max(20_000),
      inReplyTo: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("thinking"),
      text: z.string().max(24_020),
      redacted: z.boolean().optional(),
      truncated: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      mimeType: z.string().max(120),
      byteLength: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool-call"),
      toolCallId: z.string().min(1).max(160),
      toolName: z.string().min(1).max(120),
      arguments: z.record(z.string(), z.json()),
    })
    .strict(),
]);

// One browser action inside a tool call: what ran, in which tab, when its input reached the page
// and where (viewport CSS pixels). Screen recorders (Aperture) read these through `aeon trace`;
// keep the shape.
const BrowserTraceActionSchema = z
  .object({
    kind: z.string().min(1).max(40),
    tabId: z.number().int().optional(),
    visible: z.boolean().optional(),
    tStart: z.number(),
    tAct: z.number().optional(),
    tEnd: z.number(),
    box: z
      .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
      .strict()
      .optional(),
    point: z.object({ x: z.number(), y: z.number() }).strict().optional(),
    dpr: z.number().optional(),
    url: z.string().max(2000).optional(),
    text: z.string().max(200).optional(),
    scroll: z
      .object({
        direction: z.string().max(10),
        amount: z.number(),
        before: z.number(),
        after: z.number(),
      })
      .strict()
      .optional(),
    failed: z.boolean().optional(),
  })
  .strict();

const PiMessageSchema = z
  .object({
    role: z.enum(["user", "assistant", "tool", "custom"]),
    content: z.array(PiContentBlockSchema).max(64),
    stopReason: z
      .enum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"])
      .optional(),
    errorMessage: z.string().max(2000).optional(),
    toolCallId: z.string().min(1).max(160).optional(),
    toolName: z.string().min(1).max(120).optional(),
    changeDiff: z.string().max(24_000).optional(),
    isError: z.boolean().optional(),
    nestedCalls: z
      .object({
        complete: z.boolean(),
        calls: z
          .array(
            z
              .object({
                id: z.string().min(1).max(200),
                name: z.string().min(1).max(120),
                arguments: z.record(z.string(), z.json()).optional(),
                argumentsBytes: z.number().int().nonnegative().optional(),
                status: z.enum(["ok", "error", "unfinished"]),
                durationMs: z.number().int().nonnegative().optional(),
                error: z.string().max(500).optional(),
              })
              .strict(),
          )
          .max(256),
      })
      .strict()
      .optional(),
    actions: z.array(BrowserTraceActionSchema).max(500).optional(),
  })
  .strict();

export const PiEntrySchema = z
  .object({
    entryId: z.string().min(1).max(160),
    parentEntryId: z.string().max(160).nullable(),
    category: z.enum(["message", "metadata", "branch", "other"]),
    timestamp: z.string().datetime(),
    message: PiMessageSchema.nullable(),
  })
  .strict();

export const PiRunStateSchema = z.enum([
  "idle",
  "running-unconfirmed",
  "uncertain",
  "needs_attention",
]);
export const ChatViewSnapshotSchema = z
  .object({
    chat: ChatSummarySchema,
    runState: PiRunStateSchema,
    contextUsage: z
      .object({
        tokens: z.number().int().nonnegative().nullable(),
        availableTokens: z.number().int().nonnegative().nullable(),
        contextWindow: z.number().int().positive().max(100_000_000),
        percent: z.number().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
    entries: z.array(PiEntrySchema).max(250),
    omittedEntryCount: z.number().int().nonnegative(),
  })
  .strict();

export const PiSessionEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("view-replaced"),
      entries: z.array(PiEntrySchema).max(250),
      runState: PiRunStateSchema,
      contextUsage: ChatViewSnapshotSchema.shape.contextUsage,
    })
    .strict(),
  z.object({ kind: z.literal("entry-added"), entry: PiEntrySchema }).strict(),
  ...(["message-start", "message-update", "message-end"] as const).map((kind) =>
    z.object({ kind: z.literal(kind), message: PiMessageSchema }).strict(),
  ),
  z
    .object({
      kind: z.literal("tool-start"),
      toolCallId: z.string().min(1).max(200),
      toolName: z.string().min(1).max(120),
      arguments: z.record(z.string(), z.json()),
      parentToolCallId: z.string().min(1).max(160).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool-update"),
      toolCallId: z.string().min(1).max(200),
      toolName: z.string().min(1).max(120),
      arguments: z.record(z.string(), z.json()),
      partialResult: z.string().max(24_020),
      /** How far a long job inside this call has got (bu.progress in browser_code). */
      progress: z
        .object({
          done: z.number().int().nonnegative(),
          total: z.number().int().nonnegative().optional(),
          label: z.string().max(200).optional(),
        })
        .strict()
        .optional(),
      parentToolCallId: z.string().min(1).max(160).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool-end"),
      changeDiff: z.string().max(24_000).optional(),
      toolCallId: z.string().min(1).max(200),
      toolName: z.string().min(1).max(120),
      result: z.string().max(24_020),
      isError: z.boolean(),
      /** Which fast path the tool used, for the speed chip and the orb. */
      path: z.enum(["recipe", "site-api", "data", "url", "read", "ui"]).optional(),
      /** Writes the step sent through sites' APIs (siteApi.write / batch), for Activity. */
      writes: z
        .array(
          z
            .object({
              site: z.string().max(200),
              operation: z.string().max(200),
              done: z.number().int().nonnegative(),
              failed: z.number().int().nonnegative(),
              items: z.array(z.string().max(80)).max(200),
            })
            .strict(),
        )
        .max(20)
        .optional(),
      durationMs: z.number().int().nonnegative().optional(),
      parentToolCallId: z.string().min(1).max(160).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("run-state"), state: PiRunStateSchema }).strict(),
  z
    .object({
      kind: z.literal("context-usage"),
      contextUsage: ChatViewSnapshotSchema.shape.contextUsage,
    })
    .strict(),
  z.object({ kind: z.literal("turn-boundary"), active: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal("queue-changed"),
      steeringCount: z.number().int().nonnegative(),
      followUpCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({ kind: z.literal("extension-ui-request"), request: PiExtensionUiRequestSchema })
    .strict(),
  z.object({ kind: z.literal("extension-ui-resolved"), requestId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("extension-ui-notice"), notice: PiExtensionUiNoticeSchema }).strict(),
  z
    .object({
      kind: z.literal("chat-metadata"),
      title: z.string().min(1).max(120),
      projectId: z.string().min(1).max(200).nullable(),
      pinned: z.boolean(),
      archived: z.boolean(),
      updatedAt: z.string().datetime(),
    })
    .strict(),
]);

export const ChatEventSchema = z
  .object({ cursor: ChatEventCursorSchema, event: PiSessionEventSchema })
  .strict();

export type ChatSummaryDto = z.infer<typeof ChatSummarySchema>;
export type ChatCatalogItemDto = z.infer<typeof ChatCatalogItemSchema>;
export type ChatEventCursorDto = z.infer<typeof ChatEventCursorSchema>;
export type ChatViewSnapshotDto = z.infer<typeof ChatViewSnapshotSchema>;
export type PiEntryDto = z.infer<typeof PiEntrySchema>;
export type PiContentBlockDto = z.infer<typeof PiContentBlockSchema>;
export type PiMessageDto = z.infer<typeof PiMessageSchema>;
export type PiSessionEventDto = z.infer<typeof PiSessionEventSchema>;
export type ChatEventDto = z.infer<typeof ChatEventSchema>;

import { validateUnsupportedFork, validateFailedFork } from "./fork-result-validation.js";
import {
  ProjectListResultSchema,
  ProjectCreateResultSchema,
  ProjectUpdateResultSchema,
  ProjectPickResultSchema,
} from "./projects.js";
import { WorkspaceFileResultSchema } from "./workspace-file.js";
import { z } from "zod";
import {
  ChatEventCursorSchema,
  ChatIdSchema,
  ChatCatalogItemSchema,
  ChatSummarySchema,
  ChatViewSnapshotSchema,
  EffectivePiResourcesSchema,
  HomeManagementSnapshotSchema,
  ManagementSnapshotSchema,
  PiUiSnapshotSchema,
  PiAttachmentSchema,
} from "./chat-dto.js";
import { PiModelCatalogSchema } from "./model-catalog-dto.js";

const RequestIdSchema = z.string().uuid();
const ChatCommandResultSchema = z.discriminatedUnion("kind", [
  ProjectListResultSchema,
  ProjectCreateResultSchema,
  ProjectUpdateResultSchema,
  ProjectPickResultSchema,
  WorkspaceFileResultSchema,
  z.object({ kind: z.literal("chat.deleted"), chatId: ChatIdSchema }).strict(),
  z.object({ kind: z.literal("chat.model-catalog"), catalog: PiModelCatalogSchema }).strict(),
  z.object({ kind: z.literal("chat.created"), chat: ChatSummarySchema }).strict(),
  z
    .object({
      kind: z.literal("chat.listed"),
      chats: z.array(ChatCatalogItemSchema).max(100),
      searchWarnings: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("chat.updated"), chat: ChatSummarySchema }).strict(),
  z.object({ kind: z.literal("chat.resources"), resources: EffectivePiResourcesSchema }).strict(),
  z.object({ kind: z.literal("management.snapshot"), snapshot: ManagementSnapshotSchema }).strict(),
  z.object({ kind: z.literal("management.home"), snapshot: HomeManagementSnapshotSchema }).strict(),
  z.object({ kind: z.literal("chat.pi-ui"), piUi: PiUiSnapshotSchema }).strict(),
  z
    .object({
      kind: z.literal("chat.extension-ui-answered"),
      chatId: ChatIdSchema,
      accepted: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("chat.controls"),
      controls: z
        .object({
          effectiveModel: z
            .object({ provider: z.string(), id: z.string(), name: z.string() })
            .strict()
            .nullable(),
          availableModels: z
            .array(
              z
                .object({
                  provider: z.string(),
                  id: z.string(),
                  name: z.string(),
                  thinkingLevels: z.array(z.string()).max(10),
                  defaultThinkingLevel: z.string(),
                })
                .strict(),
            )
            .max(500),
          thinkingLevel: z.string(),
          availableThinkingLevels: z.array(z.string()).max(10),
          steeringQueue: z.array(z.string().max(50_000)).max(100),
          followUpQueue: z.array(z.string().max(50_000)).max(100),
          active: z.boolean(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("chat.queued"),
      chatId: ChatIdSchema,
      mode: z.enum(["followUp", "steer"]),
    })
    .strict(),
  z.object({ kind: z.literal("chat.stopped"), chatId: ChatIdSchema }).strict(),
  z.object({ kind: z.literal("chat.model-set"), chatId: ChatIdSchema }).strict(),
  z.object({ kind: z.literal("chat.thinking-set"), chatId: ChatIdSchema }).strict(),
  z
    .object({
      kind: z.literal("chat.browser-context-attached"),
      chatId: ChatIdSchema,
      status: z.enum(["attached", "stale", "lost", "offline"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("chat.view"),
      snapshot: ChatViewSnapshotSchema,
      cursor: ChatEventCursorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("chat.tree-navigated"),
      entryId: z.string().min(1).max(160),
      cancelled: z.boolean(),
      editorText: z.string().max(50_000).nullable(),
      snapshot: ChatViewSnapshotSchema,
      cursor: ChatEventCursorSchema,
    })
    .strict()
    .superRefine((result, context) => {
      if (result.cancelled && result.editorText !== null)
        context.addIssue({
          code: "custom",
          message: "Cancelled navigation cannot return editor text.",
        });
    }),
  z
    .object({
      kind: z.literal("chat.message-forked"),
      sourceChatId: ChatIdSchema,
      entryId: z.string().min(1).max(160),
      status: z.enum(["ready", "unsupported", "failed", "uncertain"]),
      targetChatId: ChatIdSchema.nullable(),
      chat: ChatSummarySchema.nullable(),
      reason: z
        .enum([
          "chat_not_ready",
          "entry_not_found",
          "branch_without_assistant",
          "fork_failed",
          "outcome_uncertain",
        ])
        .nullable(),
    })
    .strict()
    .superRefine((result, context) => {
      if (result.status === "ready" && (!result.targetChatId || !result.chat || result.reason))
        context.addIssue({ code: "custom", message: "A ready fork requires its child Chat." });
      validateUnsupportedFork(result, context);
      validateFailedFork(result, context);
    }),
  z
    .object({
      kind: z.literal("chat.message-edited"),
      chatId: ChatIdSchema,
      entryId: z.string().min(1).max(160),
      status: z.enum(["ready", "cancelled", "unsupported"]),
      editorText: z.string().max(50_000).nullable(),
      attachments: z.array(PiAttachmentSchema).max(3),
      notice: z.enum(["text_attachments_remain_inline"]).nullable(),
      reason: z
        .enum([
          "not_user_message",
          "text_exceeds_composer_limit",
          "image_attachment_not_supported",
          "image_attachment_limit_exceeded",
        ])
        .nullable(),
      snapshot: ChatViewSnapshotSchema,
      cursor: ChatEventCursorSchema,
    })
    .strict()
    .superRefine((result, context) => {
      if (result.status === "ready" && (result.editorText === null || result.reason !== null))
        context.addIssue({ code: "custom", message: "A ready edit requires its text." });
      if (
        result.status === "cancelled" &&
        [result.editorText, result.reason].some((value) => value !== null)
      )
        context.addIssue({ code: "custom", message: "A cancelled edit cannot return a draft." });
      if (result.status === "unsupported" && (result.editorText !== null || result.reason === null))
        context.addIssue({ code: "custom", message: "An unsupported edit requires a reason." });
      if (result.status !== "ready" && (result.attachments.length || result.notice !== null))
        context.addIssue({ code: "custom", message: "Only a ready edit can restore attachments." });
    }),
]);

export const ChatCommandCompletedSchema = z
  .object({
    kind: z.literal("command.completed"),
    requestId: RequestIdSchema,
    operation: z.enum([
      "project.list",
      "project.create",
      "project.update",
      "project.pick-folder",
      "workspace.file",
      "chat.model-catalog",
      "chat.create",
      "chat.list",
      "chat.get",
      "chat.resources",
      "management.get",
      "management.home",
      "management.action",
      "chat.pi-ui",
      "chat.navigate-tree",
      "chat.edit-message",
      "chat.fork-message",
      "chat.compact",
      "chat.extension-ui-answer",
      "chat.update",
      "chat.delete",
      "chat.controls",
      "chat.model",
      "chat.thinking",
      "chat.attach-browser-context",
      "chat.queue",
      "chat.queue-edit",
      "chat.stop",
    ]),
    result: ChatCommandResultSchema,
  })
  .strict();

export const ChatCommandFailedSchema = z
  .object({
    kind: z.literal("command.failed"),
    requestId: RequestIdSchema,
    operation: z.enum([
      "project.list",
      "project.create",
      "project.update",
      "project.pick-folder",
      "workspace.file",
      "chat.image",
      "chat.model-catalog",
      "chat.create",
      "chat.list",
      "chat.get",
      "chat.resources",
      "management.get",
      "management.home",
      "management.action",
      "chat.pi-ui",
      "chat.navigate-tree",
      "chat.edit-message",
      "chat.fork-message",
      "chat.compact",
      "chat.extension-ui-answer",
      "chat.update",
      "chat.delete",
      "chat.controls",
      "chat.model",
      "chat.thinking",
      "chat.queue",
      "chat.queue-edit",
      "chat.attach-browser-context",
      "chat.stop",
      "chat.submit",
    ]),
    code: z.enum(["CHAT_NOT_FOUND", "PI_UNAVAILABLE", "PI_PROMPT_FAILED", "INVALID_COMMAND"]),
    message: z.string().min(1).max(300),
  })
  .strict();

export const ChatCommandStartedSchema = z
  .object({
    kind: z.literal("command.started"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.submit"),
    chatId: ChatIdSchema,
    state: z.literal("processing"),
    piAcceptance: z.literal("unknown"),
  })
  .strict();
export const ChatCommandSettledSchema = z
  .object({
    kind: z.literal("command.settled"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.submit"),
    chatId: ChatIdSchema,
    state: z.literal("settled"),
    runState: z.enum(["idle", "running-unconfirmed", "uncertain", "needs_attention"]),
  })
  .strict();
export const ChatCommandSubmitFailedSchema = z
  .object({
    kind: z.literal("command.settled"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.submit"),
    chatId: ChatIdSchema,
    state: z.literal("failed"),
    runState: z.enum(["idle", "running-unconfirmed", "uncertain", "needs_attention"]),
    code: z.literal("PI_PROMPT_FAILED"),
    message: z.string().min(1).max(300),
    piAcceptance: z.literal("unknown"),
  })
  .strict();

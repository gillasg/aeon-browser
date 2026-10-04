import {
  ProjectListRequestSchema,
  ProjectCreateRequestSchema,
  ProjectUpdateRequestSchema,
  ProjectPickRequestSchema,
} from "./projects.js";
import { WorkspaceFileRequestSchema } from "./workspace-file.js";
import { z } from "zod";
import { ChatImageRequestSchema } from "./image-asset.js";
import {
  ChatCommandCompletedSchema as CommandCompletedSchema,
  ChatCommandFailedSchema as CommandFailedSchema,
  ChatCommandStartedSchema as CommandStartedSchema,
  ChatCommandSettledSchema as CommandSettledSchema,
  ChatCommandSubmitFailedSchema as CommandSubmitFailedSchema,
} from "./chat-command-response.js";
import {
  ChatEventCursorSchema,
  ChatEventSchema,
  ChatIdSchema,
  PiAttachmentSchema,
  ChatViewSnapshotSchema,
} from "./chat-dto.js";
import { PiBrowserContextRecordSchema } from "./browser-context.js";
import { BrowserTargetKeySchema } from "./browser-inventory.js";
import {
  ChatModelCatalogRequestSchema,
  ChatPiUiRequestSchema,
  ChatNavigateTreeRequestSchema,
  ChatEditMessageRequestSchema,
  ChatForkMessageRequestSchema,
  ChatCompactRequestSchema,
  ChatExtensionUiAnswerRequestSchema,
  ChatControlsRequestSchema,
  ChatModelRequestSchema,
  ChatThinkingRequestSchema,
} from "./chat-session-requests.js";
import {
  ManagementActionRequestSchema,
  ManagementGetRequestSchema,
  ManagementHomeRequestSchema,
} from "./management-requests.js";

const RequestIdSchema = z.string().uuid();
const AttachmentsSchema = z
  .array(PiAttachmentSchema)
  .max(3)
  .optional()
  .refine(
    (items) => !items || items.reduce((sum, item) => sum + item.byteLength, 0) <= 2_097_152,
    "Combined attachment size must not exceed 2 MiB.",
  );
const ChatCreateRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.create"),
    payload: z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        projectId: z.string().uuid().optional(),
      })
      .strict(),
  })
  .strict();
const ChatListRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.list"),
    payload: z
      .object({
        limit: z.number().int().min(1).max(100),
        query: z.string().trim().max(200).optional(),
        includeArchived: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();
const ChatDeleteRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.delete"),
    payload: z.object({ chatId: ChatIdSchema }).strict(),
  })
  .strict();
const ChatUpdateRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.update"),
    payload: z
      .object({
        chatId: ChatIdSchema,
        title: z.string().trim().min(1).max(120).optional(),
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
      })
      .strict()
      .refine(
        (patch) =>
          patch.title !== undefined || patch.pinned !== undefined || patch.archived !== undefined,
      ),
  })
  .strict();
const ChatGetRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.get"),
    payload: z.object({ chatId: ChatIdSchema }).strict(),
  })
  .strict();
const ChatResourcesRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.resources"),
    payload: z.object({ chatId: ChatIdSchema }).strict(),
  })
  .strict();
const ChatSubmitRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.submit"),
    payload: z
      .object({
        chatId: ChatIdSchema,
        text: z.string().trim().min(1).max(50_000),
        attachments: AttachmentsSchema,
        browserContext: PiBrowserContextRecordSchema.optional(),
        browserContexts: z.array(PiBrowserContextRecordSchema).max(8).optional(),
      })
      .strict(),
  })
  .strict();

const ChatAttachBrowserContextRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.attach-browser-context"),
    payload: z
      .object({
        chatId: ChatIdSchema,
        target: BrowserTargetKeySchema,
        url: z.string().url().max(2048),
      })
      .strict(),
  })
  .strict();
const ChatQueueRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.queue"),
    payload: z
      .object({
        chatId: ChatIdSchema,
        mode: z.enum(["followUp", "steer"]),
        text: z.string().trim().min(1).max(50_000),
        attachments: AttachmentsSchema,
        browserContext: PiBrowserContextRecordSchema.optional(),
        browserContexts: z.array(PiBrowserContextRecordSchema).max(8).optional(),
      })
      .strict(),
  })
  .strict();
const ChatQueueEditRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.queue-edit"),
    payload: z
      .object({
        chatId: ChatIdSchema,
        mode: z.enum(["followUp", "steer"]),
        index: z.number().int().min(0).max(99),
        action: z.enum(["delete", "edit", "up", "down", "steer"]),
        text: z.string().trim().min(1).max(50_000).optional(),
        steering: z.array(z.string()).max(100),
        followUp: z.array(z.string()).max(100),
      })
      .strict(),
  })
  .strict();
const ChatStopRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.stop"),
    payload: z.object({ chatId: ChatIdSchema }).strict(),
  })
  .strict();

export const ChatCommandRequestSchema = z.discriminatedUnion("operation", [
  ProjectListRequestSchema,
  ProjectCreateRequestSchema,
  ProjectUpdateRequestSchema,
  ProjectPickRequestSchema,
  WorkspaceFileRequestSchema,
  ChatImageRequestSchema,
  ChatModelCatalogRequestSchema,
  ChatCreateRequestSchema,
  ChatListRequestSchema,
  ChatUpdateRequestSchema,
  ChatDeleteRequestSchema,
  ChatGetRequestSchema,
  ChatResourcesRequestSchema,
  ManagementGetRequestSchema,
  ManagementHomeRequestSchema,
  ManagementActionRequestSchema,
  ChatPiUiRequestSchema,
  ChatNavigateTreeRequestSchema,
  ChatEditMessageRequestSchema,
  ChatForkMessageRequestSchema,
  ChatCompactRequestSchema,
  ChatExtensionUiAnswerRequestSchema,
  ChatSubmitRequestSchema,
  ChatControlsRequestSchema,
  ChatModelRequestSchema,
  ChatThinkingRequestSchema,
  ChatAttachBrowserContextRequestSchema,
  ChatQueueRequestSchema,
  ChatQueueEditRequestSchema,
  ChatStopRequestSchema,
]);

export const ChatSubscribeRequestSchema = z
  .object({
    kind: z.literal("chat.subscribe"),
    requestId: RequestIdSchema,
    chatId: ChatIdSchema,
    afterCursor: ChatEventCursorSchema.optional(),
  })
  .strict();

export const ChatCloseViewRequestSchema = z
  .object({
    kind: z.literal("chat.close-view"),
    requestId: RequestIdSchema,
    chatId: ChatIdSchema,
    subscriptionId: RequestIdSchema,
  })
  .strict();

export const DaemonUiRequestSchema = z.discriminatedUnion("kind", [
  ChatCommandRequestSchema,
  ChatSubscribeRequestSchema,
  ChatCloseViewRequestSchema,
]);

export const ChatSnapshotMessageSchema = z
  .object({
    kind: z.literal("chat.snapshot"),
    requestId: RequestIdSchema,
    subscriptionId: RequestIdSchema,
    cursor: ChatEventCursorSchema,
    snapshot: ChatViewSnapshotSchema,
  })
  .strict();

export const ChatResumedMessageSchema = z
  .object({
    kind: z.literal("chat.resumed"),
    requestId: RequestIdSchema,
    subscriptionId: RequestIdSchema,
    cursor: ChatEventCursorSchema,
  })
  .strict();

export const ChatEventMessageSchema = z
  .object({
    kind: z.literal("chat.event"),
    subscriptionId: RequestIdSchema,
    chatId: ChatIdSchema,
    event: ChatEventSchema,
  })
  .strict();

export const ChatViewClosedMessageSchema = z
  .object({
    kind: z.literal("chat.view-closed"),
    requestId: RequestIdSchema,
    chatId: ChatIdSchema,
    subscriptionId: RequestIdSchema,
  })
  .strict();

export const ChatSubscriptionFailedMessageSchema = z
  .object({
    kind: z.literal("chat.subscription-failed"),
    requestId: RequestIdSchema,
    chatId: ChatIdSchema,
    code: z.enum(["CHAT_NOT_FOUND", "PI_UNAVAILABLE", "INVALID_COMMAND"]),
    message: z.string().min(1).max(300),
  })
  .strict();

export const DaemonUiResponseSchema = z.union([
  CommandCompletedSchema,
  CommandFailedSchema,
  CommandStartedSchema,
  CommandSettledSchema,
  CommandSubmitFailedSchema,
  ChatSnapshotMessageSchema,
  ChatResumedMessageSchema,
  ChatEventMessageSchema,
  ChatSubscriptionFailedMessageSchema,
  ChatViewClosedMessageSchema,
]);

export type DaemonUiRequest = z.infer<typeof DaemonUiRequestSchema>;
export type ChatCommandRequest = z.infer<typeof ChatCommandRequestSchema>;
export type DaemonUiResponse = z.infer<typeof DaemonUiResponseSchema>;

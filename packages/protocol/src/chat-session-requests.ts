import { z } from "zod";
import { ChatIdSchema } from "./chat-catalog-dto.js";

const RequestIdSchema = z.string().uuid();

export const ChatModelCatalogRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.model-catalog"),
    payload: z.object({}).strict(),
  })
  .strict();

export const ChatPiUiRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.pi-ui"),
    payload: z.object({ chatId: ChatIdSchema }).strict(),
  })
  .strict();
export const ChatNavigateTreeRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.navigate-tree"),
    payload: z.object({ chatId: ChatIdSchema, entryId: z.string().min(1).max(160) }).strict(),
  })
  .strict();
export const ChatEditMessageRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.edit-message"),
    payload: z.object({ chatId: ChatIdSchema, entryId: z.string().min(1).max(160) }).strict(),
  })
  .strict();
export const ChatForkMessageRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.fork-message"),
    payload: z
      .object({
        chatId: ChatIdSchema,
        entryId: z.string().min(1).max(160),
        title: z.string().trim().min(1).max(120).optional(),
      })
      .strict(),
  })
  .strict();
export const ChatCompactRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.compact"),
    payload: z
      .object({ chatId: ChatIdSchema, customInstructions: z.string().max(1000).optional() })
      .strict(),
  })
  .strict();
export const ChatExtensionUiAnswerRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.extension-ui-answer"),
    payload: z
      .object({
        chatId: ChatIdSchema,
        dialogRequestId: RequestIdSchema,
        value: z.union([z.string().max(20_000), z.boolean(), z.null()]),
      })
      .strict(),
  })
  .strict();
export const ChatControlsRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.controls"),
    payload: z.object({ chatId: ChatIdSchema }).strict(),
  })
  .strict();
export const ChatModelRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.model"),
    payload: z
      .object({
        chatId: ChatIdSchema,
        provider: z.string().min(1).max(120),
        id: z.string().min(1).max(300),
      })
      .strict(),
  })
  .strict();
export const ChatThinkingRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("chat.thinking"),
    payload: z.object({ chatId: ChatIdSchema, level: z.string().min(1).max(40) }).strict(),
  })
  .strict();

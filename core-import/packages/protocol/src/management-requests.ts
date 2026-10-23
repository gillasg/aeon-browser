import { z } from "zod";
import { ChatIdSchema } from "./chat-dto.js";

const RequestIdSchema = z.string().uuid();

export const ManagementGetRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("management.get"),
    payload: z.object({ chatId: ChatIdSchema.optional() }).strict(),
  })
  .strict();

export const ManagementHomeRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("management.home"),
    payload: z.object({}).strict(),
  })
  .strict();

export const ManagementActionRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: RequestIdSchema,
    operation: z.literal("management.action"),
    payload: z
      .object({
        chatId: ChatIdSchema,
        action: z.enum([
          "create_routine",
          "update_routine",
          "run_routine",
          "delete_routine",
          "register_capability",
          "update_capability",
          "remove_capability",
          "recheck_capability",
          "pin_result",
        ]),
        input: z.record(z.string(), z.unknown()),
      })
      .strict(),
  })
  .strict();

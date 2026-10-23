import { z } from "zod";
import { ChatIdSchema } from "./chat-dto.js";

export const WorkspaceFileRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: z.string().uuid(),
    operation: z.literal("workspace.file"),
    payload: z.object({ chatId: ChatIdSchema, path: z.string().min(1).max(4096) }).strict(),
  })
  .strict();
export const WorkspaceFileResultSchema = z
  .object({
    kind: z.literal("workspace.file"),
    path: z.string(),
    content: z.string().max(1_048_576),
    language: z.string(),
    original: z.string().max(1_048_576).nullable(),
  })
  .strict();

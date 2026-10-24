import { z } from "zod";
import { PiAttachmentSchema } from "./chat-dto.js";
import { PiBrowserContextRecordSchema } from "@browserkit/protocol";

export const ChatInitialPromptSchema = z
  .object({
    text: z.string().trim().min(1).max(50_000),
    model: z
      .object({ provider: z.string().min(1).max(120), id: z.string().min(1).max(300) })
      .strict(),
    thinkingLevel: z.string().min(1).max(40),
    attachments: z
      .array(PiAttachmentSchema)
      .max(3)
      .optional()
      .refine(
        (items) => !items || items.reduce((sum, item) => sum + item.byteLength, 0) <= 2_097_152,
        "Combined attachment size must not exceed 2 MiB.",
      ),
    browserContexts: z.array(PiBrowserContextRecordSchema).max(8).optional(),
    /** True only when a person typed this in Aeon's own UI: never page or agent text. */
    typedByUser: z.boolean().optional(),
  })
  .strict();

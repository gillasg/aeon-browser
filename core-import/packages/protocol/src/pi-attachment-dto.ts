import { z } from "zod";

export const PiAttachmentSchema = z
  .object({
    name: z.string().min(1).max(200),
    mimeType: z.enum([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
    ]),
    data: z.string().max(1_400_000),
    byteLength: z.number().int().positive().max(1_048_576),
  })
  .strict()
  .superRefine((attachment, context) => {
    const image = attachment.mimeType.startsWith("image/");
    const maxBytes = image ? 1_048_576 : 262_144;
    if (attachment.byteLength > maxBytes)
      context.addIssue({ code: "custom", message: "Attachment exceeds its per-file byte limit." });
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attachment.data))
      context.addIssue({ code: "custom", message: "Attachment payload must be base64." });
    if (attachment.data.length !== Math.ceil(attachment.byteLength / 3) * 4)
      context.addIssue({
        code: "custom",
        message: "Attachment encoded size does not match its byte length.",
      });
  });
export type PiAttachmentDto = z.infer<typeof PiAttachmentSchema>;

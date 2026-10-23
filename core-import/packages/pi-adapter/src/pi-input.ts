import { Buffer } from "node:buffer";
import type { PiSessionInput } from "@aeon/domain";

export function decodePiInput(input: PiSessionInput): {
  text: string;
  attachmentText: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  browserContext?: PiSessionInput["browserContext"];
  browserContexts?: PiSessionInput["browserContexts"];
} {
  if (!input.text.trim()) throw new Error("Prompt text must not be empty.");
  const attachments = input.attachments ?? [];
  if (attachments.length > 3) throw new Error("At most three attachments are allowed per message.");
  let total = 0;
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  const textParts: string[] = [];
  for (const attachment of attachments) {
    const decoded = decodeAttachment(attachment);
    total += decoded.byteLength;
    if (total > 2_097_152) throw new Error("Combined attachment size exceeds 2 MiB.");
    if (decoded.image) images.push(decoded.image);
    if (decoded.text !== undefined) textParts.push(decoded.text);
  }
  return {
    text: input.text,
    attachmentText: textParts.join(""),
    images,
    ...(input.browserContext ? { browserContext: input.browserContext } : {}),
    ...(input.browserContexts ? { browserContexts: input.browserContexts } : {}),
  };
}

function decodeAttachment(attachment: NonNullable<PiSessionInput["attachments"]>[number]): {
  byteLength: number;
  image?: { type: "image"; data: string; mimeType: string };
  text?: string;
} {
  const imageMime = isImageMime(attachment.mimeType);
  if (!imageMime && !isTextMime(attachment.mimeType))
    throw new Error(`Unsupported attachment: ${attachment.name}`);
  const maxBytes = imageMime ? 1_048_576 : 262_144;
  if (attachment.byteLength < 1 || attachment.byteLength > maxBytes)
    throw new Error(`Attachment size limit exceeded: ${attachment.name}`);
  if (!isBase64(attachment.data))
    throw new Error(`Attachment data is not valid base64: ${attachment.name}`);
  const bytes = Buffer.from(attachment.data, "base64");
  if (bytes.length !== attachment.byteLength)
    throw new Error(`Attachment size did not match: ${attachment.name}`);
  return imageMime
    ? {
        byteLength: bytes.length,
        image: { type: "image", data: bytes.toString("base64"), mimeType: attachment.mimeType },
      }
    : {
        byteLength: bytes.length,
        text: `\n\n--- Attached file: ${attachment.name} ---\n${bytes.toString("utf8")}\n--- End attached file ---`,
      };
}

function isImageMime(value: string): boolean {
  return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(value);
}
function isTextMime(value: string): boolean {
  return ["text/plain", "text/markdown", "text/csv", "application/json"].includes(value);
}
function isBase64(value: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

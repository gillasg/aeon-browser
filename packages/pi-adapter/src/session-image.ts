import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
export function readToolImage(
  manager: SessionManager,
  toolCallId: string,
  index: number,
): { mimeType: string; bytes: Uint8Array } {
  const entry = manager
    .getBranch()
    .reverse()
    .find(
      (item) =>
        item.type === "message" &&
        item.message.role === "toolResult" &&
        item.message.toolCallId === toolCallId,
    );
  if (!entry || entry.type !== "message" || entry.message.role !== "toolResult")
    throw new Error("Image result is not in this thread's current branch");
  const image = entry.message.content.filter((block) => block.type === "image")[index];
  if (!image || image.type !== "image" || image.data.length > 5_592_408)
    throw new Error("Image unavailable or oversized");
  const bytes = Buffer.from(image.data, "base64");
  if (!bytes.length || bytes.length > 4_194_304) throw new Error("Image unavailable or oversized");
  return { mimeType: image.mimeType, bytes };
}

// Ids are hashes of the image data; projecting a transcript asks again and again, so keep a few.
const ids = new Map<string, string>();
/** A stable id for an image in a message (the user's attachments too), from its data. */
export function imageIdOf(data: string): string {
  const known = ids.get(data);
  if (known) return known;
  const id = createHash("sha256").update(data).digest("hex").slice(0, 32);
  if (ids.size >= 64) ids.delete(ids.keys().next().value as string);
  ids.set(data, id);
  return id;
}

/** An image anywhere in the thread's current branch (user attachments, tool results), by id. */
export function readMessageImage(
  manager: SessionManager,
  imageId: string,
): { mimeType: string; bytes: Uint8Array } {
  for (const entry of manager.getBranch()) {
    if (entry.type !== "message") continue;
    const content = (entry.message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content as { type?: string; data?: unknown; mimeType?: unknown }[]) {
      if (block.type !== "image" || typeof block.data !== "string") continue;
      if (block.data.length > 5_592_408 || imageIdOf(block.data) !== imageId) continue;
      return {
        mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png",
        bytes: Buffer.from(block.data, "base64"),
      };
    }
  }
  throw new Error("Image is not in this thread's current branch");
}

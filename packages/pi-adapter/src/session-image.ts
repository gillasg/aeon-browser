import { Buffer } from "node:buffer";
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

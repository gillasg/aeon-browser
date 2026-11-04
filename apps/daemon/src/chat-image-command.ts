import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { asChatId } from "@aeon/domain";
import {
  encodeImageAsset,
  ImageAssetHeaderSchema,
  MAX_IMAGE_ASSET_BYTES,
  type DaemonUiRequest,
} from "@aeon/protocol";
import type { WebSocket } from "ws";
import type { ChatService } from "./chat-service.js";
import { IMAGE_TYPES, workspacePath } from "./workspace-file-command.js";
export async function sendChatImage(
  socket: WebSocket,
  service: ChatService,
  request: Extract<DaemonUiRequest, { operation: "chat.image" }>,
): Promise<void> {
  const payload = request.payload;
  // "image:<id>" is an image inside a message (an attachment the user sent), not a file.
  const messageImage = "path" in payload ? /^image:([a-f0-9]{32})$/.exec(payload.path) : null;
  const image =
    "path" in payload
      ? messageImage
        ? await service.readMessageImage(asChatId(payload.chatId), messageImage[1] as string)
        : await readWorkspaceImage(service, payload.chatId, payload.path)
      : await service.readToolImage(asChatId(payload.chatId), payload.toolCallId, payload.index);
  const header = ImageAssetHeaderSchema.parse({
    kind: "image.asset",
    requestId: request.requestId,
    mimeType: image.mimeType,
    byteLength: image.bytes.byteLength,
    checksum: createHash("sha256").update(image.bytes).digest("hex"),
  });
  if (socket.readyState === 1) socket.send(encodeImageAsset(header, image.bytes), { binary: true });
}

async function readWorkspaceImage(
  service: ChatService,
  chatId: string,
  requested: string,
): Promise<{ mimeType: string; bytes: Uint8Array }> {
  const path = await workspacePath(service, chatId, requested);
  const mimeType = IMAGE_TYPES[extname(path).slice(1).toLowerCase()];
  if (!mimeType) throw new Error("Only PNG, JPEG, WebP and GIF images show in the chat.");
  if ((await stat(path)).size > MAX_IMAGE_ASSET_BYTES)
    throw new Error("This image is larger than 4 MB; open it from the chat's folder.");
  return { mimeType, bytes: await readFile(path) };
}

import { createHash } from "node:crypto";
import { asChatId } from "@pippin/domain";
import { encodeImageAsset, ImageAssetHeaderSchema, type DaemonUiRequest } from "@pippin/protocol";
import type { WebSocket } from "ws";
import type { ChatService } from "./chat-service.js";
export async function sendChatImage(
  socket: WebSocket,
  service: ChatService,
  request: Extract<DaemonUiRequest, { operation: "chat.image" }>,
): Promise<void> {
  const image = await service.readToolImage(
    asChatId(request.payload.chatId),
    request.payload.toolCallId,
    request.payload.index,
  );
  const header = ImageAssetHeaderSchema.parse({
    kind: "image.asset",
    requestId: request.requestId,
    mimeType: image.mimeType,
    byteLength: image.bytes.byteLength,
    checksum: createHash("sha256").update(image.bytes).digest("hex"),
  });
  if (socket.readyState === 1) socket.send(encodeImageAsset(header, image.bytes), { binary: true });
}

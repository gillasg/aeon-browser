import { decodeImageAsset, MAX_IMAGE_ASSET_BYTES, type DaemonUiResponse } from "@aeon/protocol";
import type { UiClient } from "./ui-client-core.js";
export function createToolImageLoader(
  getClient: () => UiClient | undefined,
  chatId: string,
): (toolCallId: string, index: number) => Promise<Blob> {
  return (toolCallId, index) => {
    const client = getClient();
    return client
      ? loadToolImage(client, chatId, toolCallId, index)
      : Promise.reject(new Error("Aeon is disconnected"));
  };
}

export function loadToolImage(
  client: UiClient,
  chatId: string,
  toolCallId: string,
  index: number,
): Promise<Blob> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => finish(new Error("Image request timed out")), 15_000);
    const unsubscribe = client.subscribe((message: DaemonUiResponse) => {
      if (message.kind === "command.failed" && message.requestId === requestId)
        finish(new Error(message.message));
    });
    let settled = false;
    function finish(error?: Error, image?: Blob) {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      unsubscribe();
      client.socket.removeEventListener("message", onMessage);
      client.socket.removeEventListener("close", onClose);
      if (error) reject(error);
      else if (image) resolve(image);
    }
    const onClose = () => finish(new Error("Image connection closed"));
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data === "string") return;
      void decodeMatchingImage(event.data, requestId)
        .then((image) => {
          if (image) finish(undefined, image);
        })
        .catch((error: unknown) =>
          finish(error instanceof Error ? error : new Error("Invalid image asset")),
        );
    };
    client.socket.addEventListener("message", onMessage);
    client.socket.addEventListener("close", onClose, { once: true });
    try {
      client.send({
        kind: "command",
        requestId,
        operation: "chat.image",
        payload: { chatId, toolCallId, index },
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Image request failed"));
    }
  });
}

async function decodeMatchingImage(
  data: Blob | ArrayBuffer,
  requestId: string,
): Promise<Blob | undefined> {
  if ((data instanceof Blob ? data.size : data.byteLength) > MAX_IMAGE_ASSET_BYTES + 2052)
    throw new Error("Image packet exceeds the limit");
  const packet = new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data);
  const { header, bytes } = decodeImageAsset(packet);
  if (header.requestId !== requestId) return undefined;
  const checksum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (checksum !== header.checksum) throw new Error("Image checksum mismatch");
  return new Blob([bytes], { type: header.mimeType });
}

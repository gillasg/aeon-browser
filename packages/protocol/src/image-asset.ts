import { z } from "zod";
export const MAX_IMAGE_ASSET_BYTES = 4_194_304;
export const ChatImageRequestSchema = z
  .object({
    kind: z.literal("command"),
    requestId: z.string().uuid(),
    operation: z.literal("chat.image"),
    payload: z
      .object({
        chatId: z.string().uuid(),
        toolCallId: z.string().min(1).max(200),
        index: z.number().int().min(0).max(63),
      })
      .strict(),
  })
  .strict();
export const ImageAssetHeaderSchema = z
  .object({
    kind: z.literal("image.asset"),
    requestId: z.string().uuid(),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    byteLength: z.number().int().positive().max(MAX_IMAGE_ASSET_BYTES),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ImageAssetHeader = z.infer<typeof ImageAssetHeaderSchema>;

export function encodeImageAsset(header: ImageAssetHeader, bytes: Uint8Array): Uint8Array {
  const metadata = new TextEncoder().encode(JSON.stringify(ImageAssetHeaderSchema.parse(header)));
  if (metadata.byteLength > 2048 || bytes.byteLength !== header.byteLength)
    throw new Error("Invalid image asset length");
  const packet = new Uint8Array(4 + metadata.length + bytes.length);
  new DataView(packet.buffer).setUint32(0, metadata.length);
  packet.set(metadata, 4);
  packet.set(bytes, 4 + metadata.length);
  return packet;
}

export function decodeImageAsset(packet: Uint8Array): {
  header: ImageAssetHeader;
  bytes: Uint8Array<ArrayBuffer>;
} {
  if (packet.byteLength < 5 || packet.byteLength > MAX_IMAGE_ASSET_BYTES + 2052)
    throw new Error("Invalid image packet size");
  const headerLength = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(
    0,
  );
  if (headerLength > 2048 || headerLength + 4 >= packet.length)
    throw new Error("Invalid image header length");
  const header = ImageAssetHeaderSchema.parse(
    JSON.parse(new TextDecoder().decode(packet.subarray(4, 4 + headerLength))),
  );
  const bytes = packet.slice(4 + headerLength);
  if (bytes.length !== header.byteLength) throw new Error("Incomplete image asset");
  return { header, bytes };
}

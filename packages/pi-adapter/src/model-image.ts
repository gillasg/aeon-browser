import { Buffer } from "node:buffer";
import { convertToPng, resizeImage, type ResizedImage } from "@earendil-works/pi-coding-agent";

/** Long side sent to the model. Larger captures trip provider image limits. */
export const MODEL_IMAGE_EDGE = 2048;

export type ModelImage = { type: "image"; data: string; mimeType: string };

interface ImageInfo {
  edge: number;
  palette: boolean;
  kind: "png" | "gif" | "jpeg" | "webp";
}

type FitResult = { image?: ModelImage; note?: string };

/**
 * The copy the model sees. GIF and palette PNG become plain PNG, and a long side
 * over 2048 is scaled down. The caller's base64 and any saved file are not written.
 * An image that cannot be made safe is left out, with a note, instead of sent raw.
 */
export async function fitModelImages(images: readonly ModelImage[]): Promise<{
  images: ModelImage[];
  notes: string[];
}> {
  const fitted: ModelImage[] = [];
  const notes: string[] = [];
  for (const [index, image] of images.entries()) {
    const result = await fitOne(image);
    if (result.image) fitted.push(result.image);
    if (result.note) notes.push(`Image ${index + 1}: ${result.note}`);
  }
  return { images: fitted, notes };
}

async function fitOne(image: ModelImage): Promise<FitResult> {
  try {
    const bytes = Buffer.from(image.data, "base64");
    const info = readInfo(bytes);
    if (leaveAsIs(image, bytes, info)) return { image };
    const prepared = needsPlainPng(image, info) ? await asPlainPng(image) : image;
    if (!prepared) return omit("could not be re-encoded as PNG");
    if (alreadyFits(prepared)) return prepared === image ? { image } : { image: prepared };
    return (await capEdge(prepared)) ?? omit("could not be capped at 2048 px");
  } catch {
    return omit("could not be prepared");
  }
}

function leaveAsIs(image: ModelImage, bytes: Buffer, info: ImageInfo | undefined): boolean {
  if (needsPlainPng(image, info)) return false;
  if (!info) return bytes.length < 32;
  return info.edge <= MODEL_IMAGE_EDGE;
}

function needsPlainPng(image: ModelImage, info: ImageInfo | undefined): boolean {
  return image.mimeType === "image/gif" || info?.kind === "gif" || info?.palette === true;
}

function alreadyFits(image: ModelImage): boolean {
  const info = readInfo(Buffer.from(image.data, "base64"));
  return (
    info !== undefined && info.edge <= MODEL_IMAGE_EDGE && !info.palette && info.kind !== "gif"
  );
}

function omit(reason: string): FitResult {
  return { note: `omitted because it ${reason}. The original is unchanged.` };
}

async function asPlainPng(image: ModelImage): Promise<ModelImage | undefined> {
  // convertToPng returns image/png bytes as they are. A palette PNG is passed as
  // another mime so Photon re-encodes it instead of handing the palette back.
  const mime = image.mimeType === "image/png" ? "image/gif" : image.mimeType;
  const png = await convertToPng(image.data, mime);
  if (!png) return undefined;
  const info = readPng(Buffer.from(png.data, "base64"));
  if (!info || info.palette) return undefined;
  return { type: "image", data: png.data, mimeType: "image/png" };
}

async function capEdge(image: ModelImage): Promise<FitResult | undefined> {
  const resized = await resizeImage(Buffer.from(image.data, "base64"), image.mimeType, {
    maxWidth: MODEL_IMAGE_EDGE,
    maxHeight: MODEL_IMAGE_EDGE,
  });
  if (!resized || !withinCap(resized)) return undefined;
  const note = resized.wasResized
    ? `shown at ${resized.width}x${resized.height} (original ${resized.originalWidth}x${resized.originalHeight}). The saved image is unchanged.`
    : undefined;
  return {
    image: { type: "image", data: resized.data, mimeType: resized.mimeType },
    ...(note ? { note } : {}),
  };
}

function withinCap(resized: ResizedImage): boolean {
  if (resized.width > MODEL_IMAGE_EDGE || resized.height > MODEL_IMAGE_EDGE) return false;
  if (resized.mimeType === "image/gif") return false;
  if (resized.mimeType !== "image/png")
    return resized.mimeType === "image/jpeg" || resized.mimeType === "image/webp";
  const info = readPng(Buffer.from(resized.data, "base64"));
  return info !== undefined && !info.palette && info.edge <= MODEL_IMAGE_EDGE;
}

function readInfo(bytes: Buffer): ImageInfo | undefined {
  return readPng(bytes) ?? readGif(bytes) ?? readJpeg(bytes) ?? readWebp(bytes);
}

function readPng(bytes: Buffer): ImageInfo | undefined {
  if (bytes.length < 26 || bytes[0] !== 0x89 || bytes.toString("ascii", 12, 16) !== "IHDR")
    return undefined;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1) return undefined;
  return { edge: Math.max(width, height), palette: bytes[25] === 3, kind: "png" };
}

function readGif(bytes: Buffer): ImageInfo | undefined {
  if (bytes.length < 10) return undefined;
  const magic = bytes.toString("ascii", 0, 6);
  if (magic !== "GIF87a" && magic !== "GIF89a") return undefined;
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  if (width < 1 || height < 1) return undefined;
  return { edge: Math.max(width, height), palette: false, kind: "gif" };
}

function readJpeg(bytes: Buffer): ImageInfo | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 4 < bytes.length) {
    const step = jpegStep(bytes, offset);
    if (step.info) return step.info;
    if (step.next === undefined) return undefined;
    offset = step.next;
  }
  return undefined;
}

function jpegStep(bytes: Buffer, offset: number): { info?: ImageInfo; next?: number } {
  const marker = jpegMarker(bytes, offset);
  if (!marker) return {};
  if (marker.standalone) return { next: marker.next };
  if (marker.next + 2 > bytes.length) return {};
  const length = bytes.readUInt16BE(marker.next);
  if (length < 2 || marker.next + length > bytes.length) return {};
  const info = jpegSize(marker.value, bytes, marker.next, length);
  return info ? { info } : { next: marker.next + length };
}

function jpegMarker(
  bytes: Buffer,
  offset: number,
): { value: number; next: number; standalone: boolean } | undefined {
  if (bytes[offset] !== 0xff) return undefined;
  let cursor = offset;
  while (cursor < bytes.length && bytes[cursor] === 0xff) cursor += 1;
  const value = bytes[cursor];
  if (value === undefined || value === 0xd9 || value === 0xda) return undefined;
  return {
    value,
    next: cursor + 1,
    standalone: value === 0x01 || (value >= 0xd0 && value <= 0xd8),
  };
}

function jpegSize(
  marker: number,
  bytes: Buffer,
  offset: number,
  length: number,
): ImageInfo | undefined {
  const sof =
    marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
  if (!sof || length < 8) return undefined;
  const height = bytes.readUInt16BE(offset + 3);
  const width = bytes.readUInt16BE(offset + 5);
  if (width < 1 || height < 1) return undefined;
  return { edge: Math.max(width, height), palette: false, kind: "jpeg" };
}

function readWebp(bytes: Buffer): ImageInfo | undefined {
  if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF") return undefined;
  if (bytes.toString("ascii", 8, 12) !== "WEBP") return undefined;
  const kind = bytes.toString("ascii", 12, 16);
  const size = webpSize(kind, bytes);
  if (!size) return undefined;
  return { edge: Math.max(size.width, size.height), palette: false, kind: "webp" };
}

function webpSize(kind: string, bytes: Buffer): { width: number; height: number } | undefined {
  if (kind === "VP8X")
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  if (kind === "VP8 " && bytes.readUIntBE(23, 3) === 0x9d012a)
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (kind === "VP8L" && bytes[20] === 0x2f) {
    const packed = bytes.readUInt32LE(21);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

import type { ComposerAttachment } from "@pippin/ui";

export async function readComposerAttachment(file: File): Promise<ComposerAttachment> {
  const mimeType = mimeFor(file);
  const maxBytes = mimeType.startsWith("image/") ? 1_048_576 : 262_144;
  if (!mimeType || file.size < 1 || file.size > maxBytes)
    throw new Error(`Unsupported file or size limit: ${file.name}`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return { name: file.name.slice(0, 200), mimeType, data: btoa(binary), byteLength: bytes.length };
}

function mimeFor(file: File): string {
  const allowed = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
  ];
  if (allowed.includes(file.type)) return file.type;
  const ext = file.name.toLocaleLowerCase().split(".").pop();
  return (
    (
      {
        txt: "text/plain",
        md: "text/markdown",
        csv: "text/csv",
        json: "application/json",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
      } as Record<string, string>
    )[ext ?? ""] ?? ""
  );
}

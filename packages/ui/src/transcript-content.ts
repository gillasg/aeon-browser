import type { PiContentBlockDto } from "@aeon/protocol";
export function timestampMs(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function blockText(content: readonly PiContentBlockDto[]): string {
  return content
    .flatMap((block) => {
      if (block.type === "text") return [block.text];
      if (block.type === "image")
        return [`Image output · ${block.mimeType} · ${block.byteLength} bytes`];
      return [];
    })
    .join("");
}

export function hasRenderableContent(content: readonly PiContentBlockDto[]): boolean {
  return content.some(
    (block) =>
      (block.type === "text" && block.text.length > 0) ||
      block.type === "browser-context" ||
      block.type === "routine-invocation" ||
      block.type === "routine-result" ||
      block.type === "thread-message" ||
      block.type === "thinking" ||
      block.type === "image",
  );
}

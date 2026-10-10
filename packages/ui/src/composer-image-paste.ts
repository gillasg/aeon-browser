import type { ClipboardEventHandler } from "react";

export function imagePasteHandler(
  onFiles?: (files: readonly File[]) => void,
): ClipboardEventHandler<HTMLElement> | undefined {
  if (!onFiles) return undefined;
  return (event) => {
    const images = [...event.clipboardData.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .flatMap((item) => {
        const file = item.getAsFile();
        return file ? [file] : [];
      });
    const files = images.length
      ? images
      : [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    onFiles(files);
  };
}

import type { ReactElement } from "react";
import type { ComposerAttachment } from "./chat-composer.js";
export function AttachmentPreview({
  file,
  onRemove,
}: {
  file: ComposerAttachment;
  onRemove(): void;
}): ReactElement {
  const image = /^image\/(png|jpeg|webp|gif)$/.test(file.mimeType);
  return (
    <div className={image ? "attachment-thumbnail" : "attachment-chip"} title={file.name}>
      {image ? (
        <img src={"data:" + file.mimeType + ";base64," + file.data} alt={file.name} />
      ) : (
        <span>{file.name}</span>
      )}
      <button type="button" aria-label={"Remove " + file.name} onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

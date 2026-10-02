import { useRef, useState, type ReactElement } from "react";
import type { ComposerAttachment } from "./chat-composer.js";
import { AttachmentButton } from "./attachment-button.js";
interface HomeAttachmentsState {
  attachments: ComposerAttachment[];
  error: string;
  loading: boolean;
  add(files: readonly File[]): Promise<void>;
  remove(index: number): void;
}
export function useHomeAttachments(
  read?: (files: readonly File[]) => Promise<ComposerAttachment[]>,
): HomeAttachmentsState {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const add = async (files: readonly File[]): Promise<void> => {
    if (!read || !files.length) return;
    setError("");
    setLoading(true);
    try {
      if (attachments.length + files.length > 3) throw new Error("Attach up to three files.");
      const values = await read(files);
      const all = [...attachments, ...values];
      if (all.reduce((bytes, file) => bytes + file.byteLength, 0) > 3_145_728)
        throw new Error("Attachments must total less than 3 MB.");
      setAttachments(all);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not attach files.");
    } finally {
      setLoading(false);
    }
  };
  return {
    attachments,
    error,
    loading,
    add,
    remove: (index: number) =>
      setAttachments((current) => current.filter((_, position) => position !== index)),
  };
}
export function HomeAttachmentPicker({
  onFiles,
}: {
  onFiles(files: readonly File[]): void;
}): ReactElement {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <AttachmentButton onClick={() => input.current?.click()} />
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif,text/plain,text/markdown,text/csv,application/json,.md,.txt,.csv,.json"
        onChange={(event) => {
          onFiles([...(event.currentTarget.files ?? [])]);
          event.currentTarget.value = "";
        }}
      />
    </>
  );
}
export function HomeAttachmentList({
  state,
}: {
  state: ReturnType<typeof useHomeAttachments>;
}): ReactElement {
  return (
    <div className="home-attachments">
      {state.attachments.map((file, index) => (
        <span className="attachment-chip" key={index}>
          <span>{file.name}</span>
          <button
            type="button"
            aria-label={"Remove " + file.name}
            onClick={() => state.remove(index)}
          >
            ×
          </button>
        </span>
      ))}
      {state.error && <p role="alert">{state.error}</p>}
    </div>
  );
}

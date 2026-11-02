import { createContext, useContext, useEffect, useState, type ReactElement } from "react";
import type { ToolStep } from "./transcript-model.js";
export type ToolImageLoader = (toolCallId: string, index: number) => Promise<Blob>;
export const ToolImageContext = createContext<ToolImageLoader | undefined>(undefined);

export function ToolImages({ step }: { step: ToolStep }): ReactElement | null {
  if (!step.images?.length) return null;
  return (
    <div className="tool-images">
      {step.images.map((image, index) => (
        <ToolImage
          key={`${step.toolCallId}:${index}`}
          toolCallId={step.toolCallId}
          index={index}
          mimeType={image.mimeType}
        />
      ))}
    </div>
  );
}

function ToolImage({
  toolCallId,
  index,
  mimeType,
}: {
  toolCallId: string;
  index: number;
  mimeType: string;
}): ReactElement {
  const loader = useContext(ToolImageContext);
  const [attempt, setAttempt] = useState(0);
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setUrl(undefined);
    setError(false);
    if (loader)
      void loader(toolCallId, index)
        .then((blob) => {
          if (!active) return;
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        })
        .catch(() => {
          if (active) setError(true);
        });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [loader, attempt, toolCallId, index]);
  return (
    <div>
      {!url ? (
        <p className="activity-result-note" role="status">
          {error || !loader ? "Image preview unavailable" : "Loading image…"} · {mimeType}
          {error && (
            <button type="button" onClick={() => setAttempt(attempt + 1)}>
              Retry image
            </button>
          )}
        </p>
      ) : (
        <a href={url} target="_blank" rel="noreferrer" aria-label="Open tool image">
          <img src={url} alt="Image returned by the tool" />
        </a>
      )}
    </div>
  );
}

/** Loads an image file from the chat's workspace by its path (media/apple.png). */
export type WorkspaceImageLoader = (path: string) => Promise<Blob>;
export const WorkspaceImageContext = createContext<WorkspaceImageLoader | undefined>(undefined);
export const IMAGE_PATH = /\.(png|jpe?g|webp|gif)$/i;

/** A saved image shown in the message, as a thumbnail that opens full size. */
export function WorkspaceImage({ path, alt }: { path: string; alt: string }): ReactElement {
  const loader = useContext(WorkspaceImageContext);
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    if (loader)
      void loader(path)
        .then((blob) => {
          if (!active) return;
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        })
        .catch((reason: unknown) => {
          if (active) setError(reason instanceof Error ? reason.message : "Image unavailable");
        });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [loader, path]);
  if (!url)
    return (
      <span className="activity-result-note" role="status">
        {!loader ? path : error ? `${path}: ${error}` : `Loading ${path}…`}
      </span>
    );
  return (
    <img
      className="markdown-image"
      src={url}
      alt={alt || path}
      title={path}
      onClick={(event) => {
        if (!event.currentTarget.closest("a")) window.open(url, "_blank", "noreferrer");
      }}
    />
  );
}

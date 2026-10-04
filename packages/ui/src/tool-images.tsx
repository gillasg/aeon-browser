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

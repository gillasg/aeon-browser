import { createContext, useContext, useEffect, useRef, useState, type ReactElement } from "react";
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
  const target = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    if (target.current) observer.observe(target.current);
    return () => observer.disconnect();
  }, []);
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setUrl(undefined);
    setError(false);
    if (loader && visible)
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
  }, [loader, visible, toolCallId, index]);
  return (
    <div ref={target}>
      {!url ? (
        <p className="activity-result-note" role="status">
          {error || !loader ? "Image preview unavailable" : "Loading image…"} · {mimeType}
        </p>
      ) : (
        <a href={url} target="_blank" rel="noreferrer" aria-label="Open tool image">
          <img src={url} alt="Image returned by the tool" />
        </a>
      )}
    </div>
  );
}

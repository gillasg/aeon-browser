import type { ReactElement } from "react";
import type { PiBrowserContextRecord } from "@aeon/protocol";

export function BrowserContextChip({
  record,
  onRemove,
}: {
  record: PiBrowserContextRecord;
  onRemove?: () => void;
}): ReactElement {
  return (
    <section className="browser-context-chip" aria-label="Attached page context">
      <span className="browser-context-page-icon" aria-hidden="true">
        {record.favIconUrl ? (
          <img src={record.favIconUrl} alt="" referrerPolicy="no-referrer" />
        ) : (
          "◎"
        )}
      </span>
      <span
        className="browser-context-page-label"
        title={`${record.title ?? record.url}\n${record.url}${record.selectedText ? "\nSelected text attached" : ""}`}
      >
        {record.title || new URL(record.url).hostname}
      </span>
      {onRemove && (
        <button
          className="browser-context-remove"
          type="button"
          aria-label="Remove page context"
          title="Remove page context"
          onClick={onRemove}
        >
          ×
        </button>
      )}
    </section>
  );
}

export function BrowserContextCard({ record }: { record: PiBrowserContextRecord }): ReactElement {
  return (
    <div className="browser-context-card" data-context-id={record.contextId}>
      <ContextIdentity record={record} />
      <ContextDetails record={record} />
    </div>
  );
}

export function BrowserContextTranscriptChip({
  record,
}: {
  record: PiBrowserContextRecord;
}): ReactElement {
  return (
    <div className="browser-context-transcript" data-context-id={record.contextId}>
      <BrowserContextChip record={record} />
    </div>
  );
}

function ContextIdentity({ record }: { record: PiBrowserContextRecord }): ReactElement {
  const url = new URL(record.url);
  return (
    <div className="browser-context-identity">
      <span className="browser-context-icon" aria-hidden="true">
        <svg viewBox="0 0 20 20">
          <rect x="2.75" y="3.25" width="14.5" height="13.5" rx="2" />
          <path d="M2.75 7h14.5M5 5.2h.01M7 5.2h.01" />
          <circle cx="11.9" cy="11.8" r="2.7" />
          <path d="M9.3 11.8h5.2M11.9 9.1c1 1.4 1 4 0 5.4M11.9 9.1c-1 1.4-1 4 0 5.4" />
        </svg>
      </span>
      <span className="browser-context-title">
        <a href={record.url} target="_blank" rel="noreferrer" title={record.title || url.hostname}>
          {record.title || url.hostname}
        </a>
        <small>{url.origin}</small>
      </span>
    </div>
  );
}

function ContextDetails({ record }: { record: PiBrowserContextRecord }): ReactElement | null {
  if (
    !record.selectedText &&
    !record.selectionTruncated &&
    (!record.sourceStatus || record.sourceStatus === "current")
  )
    return null;
  return (
    <div className="browser-context-details">
      {record.selectedText && (
        <details>
          <summary>{record.kind === "selection" ? "Selected text" : "Page text"}</summary>
          <p>{record.selectedText}</p>
        </details>
      )}
      {record.selectionTruncated && <small>Selection shortened to 8,000 characters</small>}
      {record.sourceStatus === "stale" && (
        <small>Page changed; captured text remains available</small>
      )}
      {record.sourceStatus === "lost" && (
        <small>Source tab closed; captured text remains available</small>
      )}
      {record.sourceStatus === "offline" && (
        <small>Browser offline; captured text remains available</small>
      )}
    </div>
  );
}

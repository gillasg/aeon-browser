import type { ReactElement, ReactNode } from "react";
import type { AnswerFooter, AnswerLine, AnswerOffer, AnswerReceipt } from "./answer-lines.js";

/**
 * What sits under an answer: what was learned, at most one quiet offer, the turn's quiet
 * duration, and the hover icons (Copy, Retry). Icons only, never emoji or a naked word.
 */
export function AnswerLines({
  footer,
  onOffer,
  onRetry,
  duration,
  copyText,
  disabled = false,
}: {
  footer: AnswerFooter;
  onOffer?(offer: AnswerOffer): void;
  onRetry?(): void;
  /** `33s`, or `⚡ 0.4s` on a fast path. */
  duration?: string;
  copyText?: string;
  disabled?: boolean;
}): ReactElement | null {
  const lines = footer.lines.filter(
    (line) => !(line.kind === "offer" && line.action === "save-ability"),
  );
  const icons = Boolean(copyText || onRetry);
  if (!lines.length && !icons && !duration) return null;
  return (
    <div className="answer-lines">
      {lines.map((line) => (
        <Line key={lineKey(line)} line={line} onOffer={onOffer} disabled={disabled} />
      ))}
      {(duration || icons) && (
        <div className="answer-meta">
          {duration && <span className="answer-duration">{duration}</span>}
          {icons && (
            <div className="answer-actions">
              {copyText && (
                <IconButton
                  label="Copy"
                  disabled={false}
                  onClick={() => void navigator.clipboard?.writeText(copyText)}
                >
                  <path d="M7.5 7.5h8v9h-8zM4.5 12.5v-9h8" />
                </IconButton>
              )}
              {onRetry && (
                <IconButton label="Retry" disabled={disabled} onClick={onRetry}>
                  <path d="M15.5 9.5A5.5 5.5 0 1 1 13.9 5.6M16 3v3.5h-3.5" />
                </IconButton>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: (() => void) | undefined;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      className="answer-icon"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}

function Line({
  line,
  onOffer,
  disabled,
}: {
  line: AnswerLine;
  onOffer: ((offer: AnswerOffer) => void) | undefined;
  disabled: boolean;
}): ReactElement {
  if (line.kind === "receipt") return <ReceiptLine line={line} />;
  if (line.kind !== "offer")
    return (
      <p className="answer-line" data-kind={line.kind}>
        {line.text}
      </p>
    );
  return (
    <p className="answer-line" data-kind="offer">
      {line.text === line.label ? null : <span>{line.text}</span>}
      <button
        type="button"
        className="answer-offer"
        disabled={disabled || !onOffer}
        onClick={() => onOffer?.(line)}
      >
        {line.label}
      </button>
    </p>
  );
}

/** The receipt: its first phrase in the answer's colour, the rest muted, numbers tabular. */
function ReceiptLine({ line }: { line: AnswerReceipt }): ReactElement {
  return (
    <p className="answer-line answer-receipt" data-kind="receipt" data-receipt={line.receipt}>
      <span className="answer-receipt-lead">{line.lead}</span>
      {line.rest.map((part) => (
        <span key={part} className="answer-receipt-rest">
          {" · "}
          {part}
        </span>
      ))}
    </p>
  );
}

function lineKey(line: AnswerLine): string {
  if (line.kind === "offer") return `offer:${line.id}`;
  return `${line.kind}:${line.text}`;
}

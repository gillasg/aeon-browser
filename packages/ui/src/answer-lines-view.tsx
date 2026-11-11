import type { ReactElement } from "react";
import type { AnswerFooter, AnswerLine, AnswerOffer } from "./answer-lines.js";

/** The learned line, the speed line and the offers, under an answer. */
export function AnswerLines({
  footer,
  onOffer,
  onWrong,
  disabled = false,
}: {
  footer: AnswerFooter;
  onOffer?(offer: AnswerOffer): void;
  onWrong?(): void;
  disabled?: boolean;
}): ReactElement | null {
  const wrong = Boolean(footer.wrong && onWrong);
  if (!footer.lines.length && !wrong) return null;
  return (
    <div className="answer-lines">
      {footer.lines.map((line) => (
        <Line key={lineKey(line)} line={line} onOffer={onOffer} disabled={disabled} />
      ))}
      {wrong ? (
        <button type="button" className="answer-offer" disabled={disabled} onClick={onWrong}>
          Wrong
        </button>
      ) : null}
    </div>
  );
}

function Line({
  line,
  onOffer,
  disabled,
}: {
  line: AnswerLine;
  onOffer?(offer: AnswerOffer): void;
  disabled: boolean;
}): ReactElement {
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

function lineKey(line: AnswerLine): string {
  if (line.kind === "offer") return `offer:${line.id}`;
  return `${line.kind}:${line.text}`;
}

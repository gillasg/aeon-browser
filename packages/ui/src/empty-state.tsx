import type { ReactElement } from "react";

/** An empty page: one line on what will appear here, and the one thing to do about it. */
export function EmptyState({
  text,
  action,
  onAction,
}: {
  text: string;
  action?: string;
  onAction?(): void;
}): ReactElement {
  return (
    <div className="aeon-empty">
      <p>{text}</p>
      {action && onAction && (
        <button type="button" className="aeon-button" data-tone="primary" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

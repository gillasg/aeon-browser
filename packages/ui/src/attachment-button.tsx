import type { ReactElement } from "react";
export function AttachmentButton({ onClick }: { onClick(): void }): ReactElement {
  return (
    <button
      className="attach-button"
      type="button"
      aria-label="Attach files"
      title="Attach files"
      onClick={onClick}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>
  );
}

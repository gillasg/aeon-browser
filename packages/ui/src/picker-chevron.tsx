import type { ReactElement } from "react";

export function PickerChevron(): ReactElement {
  return (
    <svg
      className="picker-chevron-icon"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path d="m3 4.5 3 3 3-3" />
    </svg>
  );
}
